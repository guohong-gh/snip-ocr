import type { UpdateOptions, UpdateProgress, UpdateStatus } from '@shared/ipc'
import type { UpdateAdapter, UpdateAdapterEvent } from './updateAdapter'

/** 由 UpdateService 回写的配置字段（与 StoredConfig 同名） */
export interface UpdateConfigPatch {
  updateAutoCheck?: boolean
  updateAutoDownload?: boolean
  updateLastCheckAt?: number
  updateLastErrorAt?: number
  updateLastErrorReason?: string
}

export interface UpdateServiceOptions {
  currentVersion: string
  /** 便携版 / 开发态不支持在线更新 */
  supported: boolean
  autoCheck: boolean
  autoDownload: boolean
  intervalHours: number
  lastCheckAt: number
  lastError: string
  lastErrorAt: number
  adapterFactory: () => Promise<UpdateAdapter>
  persist: (patch: UpdateConfigPatch) => void
  notify: (title: string, body: string) => void
  onStatus: (status: UpdateStatus) => void
  onProgress: (progress: UpdateProgress) => void
}

const PROGRESS_MIN_INTERVAL_MS = 500
const AUTO_FIRST_CHECK_MS = 60_000
const AUTO_TICK_MS = 6 * 3600_000

/**
 * 更新状态机：单飞、节流、开关、失败留痕。
 * 适配器只负责产生事件，所有对外状态写入都在这里完成。
 */
export class UpdateService {
  private status: UpdateStatus
  private readonly options: UpdateServiceOptions
  private adapterPromise: Promise<UpdateAdapter> | null = null
  private unsubscribe: (() => void) | null = null
  private checkingPromise: Promise<UpdateStatus> | null = null
  private downloadingPromise: Promise<UpdateStatus> | null = null
  private lastProgressAt = 0
  private firstCheckTimer: ReturnType<typeof setTimeout> | null = null
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  private cancelledByUser = false

  constructor(options: UpdateServiceOptions) {
    this.options = options
    this.status = {
      phase: 'idle',
      currentVersion: options.currentVersion,
      latestVersion: null,
      notes: null,
      error: options.lastError || null,
      errorAt: options.lastErrorAt || null,
      checkedAt: options.lastCheckAt || null,
      autoCheck: options.autoCheck,
      autoDownload: options.autoDownload,
      supported: options.supported,
    }
  }

  getStatus(): UpdateStatus {
    return { ...this.status }
  }

  private setStatus(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch }
    this.options.onStatus(this.getStatus())
  }

  private async getAdapter(): Promise<UpdateAdapter> {
    if (!this.adapterPromise) {
      this.adapterPromise = this.options.adapterFactory().then((adapter) => {
        this.unsubscribe = adapter.subscribe((event) => this.handleEvent(event))
        return adapter
      })
    }
    return this.adapterPromise
  }

  private handleEvent(event: UpdateAdapterEvent): void {
    switch (event.type) {
      case 'checking':
        if (this.status.phase !== 'checking') this.setStatus({ phase: 'checking', error: null, errorAt: null })
        return
      case 'available': {
        this.markChecked()
        this.setStatus({
          phase: 'available',
          latestVersion: event.version,
          notes: event.notes,
          error: null,
          errorAt: null,
        })
        this.clearPersistedError()
        if (this.status.autoDownload) void this.download()
        return
      }
      case 'not-available':
        this.markChecked()
        this.setStatus({
          phase: 'latest',
          latestVersion: event.version || this.status.currentVersion,
          notes: null,
          error: null,
          errorAt: null,
        })
        this.clearPersistedError()
        return
      case 'progress':
        if (this.status.phase !== 'downloading') this.setStatus({ phase: 'downloading' })
        this.emitProgress({
          percent: event.percent,
          transferred: event.transferred,
          total: event.total,
        })
        return
      case 'downloaded':
        this.setStatus({ phase: 'downloaded', latestVersion: event.version, error: null, errorAt: null })
        this.options.notify('更新已下载', `v${event.version} 已下载，重启后完成安装`)
        return
      case 'cancelled':
        this.cancelledByUser = false
        this.setStatus({ phase: 'available' })
        return
      case 'error':
        if (this.cancelledByUser) {
          this.cancelledByUser = false
          this.setStatus({ phase: 'available' })
          return
        }
        this.fail(event.message)
        return
    }
  }

  private emitProgress(progress: UpdateProgress): void {
    const now = Date.now()
    // 每 500ms 合并一次，避免高频 IPC；最后一条 100% 必须放行
    if (progress.percent < 100 && now - this.lastProgressAt < PROGRESS_MIN_INTERVAL_MS) return
    this.lastProgressAt = now
    this.options.onProgress(progress)
  }

  private markChecked(): void {
    const at = Date.now()
    this.setStatus({ checkedAt: at })
    this.options.persist({ updateLastCheckAt: at })
  }

  private clearPersistedError(): void {
    this.options.persist({ updateLastErrorReason: '', updateLastErrorAt: 0 })
  }

  private fail(message: string): void {
    const reason = message.trim() || '未知错误'
    const at = Date.now()
    this.setStatus({ phase: 'error', error: reason, errorAt: at })
    this.options.persist({ updateLastErrorReason: reason, updateLastErrorAt: at })
  }

  /** trigger=auto 时受自动检查开关与间隔约束；manual 不受节流影响 */
  async check(trigger: 'manual' | 'auto' = 'manual'): Promise<UpdateStatus> {
    if (!this.status.supported) return this.getStatus()
    if (trigger === 'auto') {
      if (!this.status.autoCheck) return this.getStatus()
      const last = this.status.checkedAt
      if (last !== null && Date.now() - last < this.options.intervalHours * 3600_000) {
        return this.getStatus()
      }
    }
    if (this.checkingPromise) return this.checkingPromise
    this.checkingPromise = this.runCheck()
    try {
      return await this.checkingPromise
    } finally {
      this.checkingPromise = null
    }
  }

  private async runCheck(): Promise<UpdateStatus> {
    this.cancelledByUser = false
    this.setStatus({ phase: 'checking', error: null })
    try {
      const adapter = await this.getAdapter()
      await adapter.check()
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error))
    }
    return this.getStatus()
  }

  async download(): Promise<UpdateStatus> {
    if (!this.status.supported) return this.getStatus()
    if (this.downloadingPromise) return this.downloadingPromise
    if (this.status.phase !== 'available') return this.getStatus()
    this.downloadingPromise = this.runDownload()
    try {
      return await this.downloadingPromise
    } finally {
      this.downloadingPromise = null
    }
  }

  private async runDownload(): Promise<UpdateStatus> {
    this.cancelledByUser = false
    this.lastProgressAt = 0
    this.setStatus({ phase: 'downloading' })
    try {
      const adapter = await this.getAdapter()
      await adapter.download()
    } catch (error) {
      if (this.cancelledByUser) {
        this.cancelledByUser = false
        this.setStatus({ phase: 'available' })
      } else {
        this.fail(error instanceof Error ? error.message : String(error))
      }
    }
    return this.getStatus()
  }

  async cancel(): Promise<UpdateStatus> {
    if (this.status.phase !== 'downloading') return this.getStatus()
    this.cancelledByUser = true
    try {
      const adapter = await this.getAdapter()
      await adapter.cancel()
    } catch {
      // 取消失败也回到可重试态，不扩大错误面
    }
    if (this.status.phase === 'downloading') this.setStatus({ phase: 'available' })
    return this.getStatus()
  }

  async install(): Promise<{ ok: boolean; error?: string }> {
    if (this.status.phase !== 'downloaded') return { ok: false, error: '当前没有已下载的更新' }
    try {
      const adapter = await this.getAdapter()
      await adapter.install()
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.fail(message)
      return { ok: false, error: message }
    }
  }

  setOptions(patch: Partial<UpdateOptions>): UpdateStatus {
    if (typeof patch.autoCheck === 'boolean') {
      this.status = { ...this.status, autoCheck: patch.autoCheck }
      this.options.persist({ updateAutoCheck: patch.autoCheck })
    }
    if (typeof patch.autoDownload === 'boolean') {
      this.status = { ...this.status, autoDownload: patch.autoDownload }
      this.options.persist({ updateAutoDownload: patch.autoDownload })
    }
    this.options.onStatus(this.getStatus())
    return this.getStatus()
  }

  /** 启动后台自动检查：60 秒首检，之后每 6 小时判断一次是否到期。自检不调用。 */
  startScheduler(): void {
    if (this.disposed || !this.status.supported) return
    this.firstCheckTimer = setTimeout(() => {
      this.firstCheckTimer = null
      void this.check('auto')
    }, AUTO_FIRST_CHECK_MS)
    this.tickTimer = setInterval(() => {
      void this.check('auto')
    }, AUTO_TICK_MS)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.firstCheckTimer !== null) {
      clearTimeout(this.firstCheckTimer)
      this.firstCheckTimer = null
    }
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.status.phase === 'downloading') {
      this.cancelledByUser = true
      const adapter = this.adapterPromise
      if (adapter) void adapter.then((instance) => instance.cancel()).catch(() => {})
    }
  }
}
