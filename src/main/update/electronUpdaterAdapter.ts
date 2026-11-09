import type { AppUpdater, CancellationToken, ProgressInfo, UpdateInfo } from 'electron-updater'
import type { UpdateAdapter, UpdateAdapterEvent } from './updateAdapter'

/** 自检断言用：真实适配器在 `--selftest` 下构造次数必须为 0 */
export let constructionCount = 0

function normalizeNotes(releaseNotes: UpdateInfo['releaseNotes']): string | null {
  if (typeof releaseNotes === 'string') return releaseNotes.trim() || null
  if (Array.isArray(releaseNotes)) {
    const text = releaseNotes
      .map((item) => (typeof item === 'object' && item !== null && 'note' in item ? String(item.note ?? '') : ''))
      .join('\n')
      .trim()
    return text || null
  }
  return null
}

/**
 * 真实更新适配器：只在打包态、非自检时构造。
 * electron-updater 通过动态 import 加载，避免自检与开发态产生
 * 读取 app-update.yml / 初始化网络栈的副作用。
 */
export class ElectronUpdaterAdapter implements UpdateAdapter {
  private readonly listeners = new Set<(event: UpdateAdapterEvent) => void>()
  private loadPromise: Promise<void> | null = null
  private updater: AppUpdater | null = null
  private tokenCtor: (new () => CancellationToken) | null = null
  private token: CancellationToken | null = null
  private cancelledByUser = false

  constructor() {
    constructionCount += 1
  }

  subscribe(listener: (event: UpdateAdapterEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(event: UpdateAdapterEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }

  /** 首次使用时才加载库并绑定事件；失败时允许下次重试 */
  private ensureUpdater(): Promise<AppUpdater> {
    if (!this.loadPromise) {
      this.loadPromise = import('electron-updater').then((mod) => {
        const updater = mod.autoUpdater
        // 下载时机由 UpdateService 控制；退出时不自动安装，必须用户显式确认重启
        updater.autoDownload = false
        updater.autoInstallOnAppQuit = false
        updater.on('checking-for-update', () => this.emit({ type: 'checking' }))
        updater.on('update-available', (info: UpdateInfo) => {
          this.emit({ type: 'available', version: info.version, notes: normalizeNotes(info.releaseNotes) })
        })
        updater.on('update-not-available', (info: UpdateInfo) => {
          this.emit({ type: 'not-available', version: info.version })
        })
        updater.on('download-progress', (progress: ProgressInfo) => {
          this.emit({
            type: 'progress',
            percent: progress.percent,
            transferred: progress.transferred,
            total: progress.total,
          })
        })
        updater.on('update-downloaded', (info: UpdateInfo) => {
          this.emit({ type: 'downloaded', version: info.version })
        })
        updater.on('error', (error: Error) => {
          if (this.cancelledByUser) this.emit({ type: 'cancelled' })
          else this.emit({ type: 'error', message: error.message })
        })
        this.updater = updater
        this.tokenCtor = mod.CancellationToken
      }).catch((error: unknown) => {
        this.loadPromise = null
        throw error
      })
    }
    return this.loadPromise.then(() => {
      if (!this.updater) throw new Error('electron-updater 初始化失败')
      return this.updater
    })
  }

  async check(): Promise<void> {
    this.cancelledByUser = false
    const updater = await this.ensureUpdater()
    await updater.checkForUpdates()
  }

  async download(): Promise<void> {
    this.cancelledByUser = false
    const updater = await this.ensureUpdater()
    if (!this.tokenCtor) throw new Error('electron-updater 初始化失败')
    this.token = new this.tokenCtor()
    await updater.downloadUpdate(this.token)
  }

  async cancel(): Promise<void> {
    this.cancelledByUser = true
    this.token?.cancel()
    this.token = null
  }

  async install(): Promise<void> {
    const updater = await this.ensureUpdater()
    // 只安装已下载的更新并退出；autoInstallOnAppQuit 已显式关闭
    updater.quitAndInstall()
  }
}
