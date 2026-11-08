import { globalShortcut } from 'electron'
import type { SetHotkeyResult } from '@shared/ipc'

/** 快捷键槽位：截图键与贴图键共用同一套注册/回滚语义 */
export type HotkeySlot = 'capture' | 'pin'

/** 注册冲突后的统一重试间隔 */
const RETRY_INTERVAL_MS = 10_000

interface SlotConfig {
  handler: () => void
  /** 注册失败回滚时，若没有上一个可用键则用该默认键兜底 */
  fallback: () => string
}

interface SlotState {
  current: string | null
  error: string | null
  retryTarget: string | null
}

type ChangeListener = (slot: HotkeySlot) => void

function tryRegister(accelerator: string, handler: () => void): boolean {
  try {
    return globalShortcut.register(accelerator, handler)
  } catch {
    return false
  }
}

/**
 * 全局快捷键注册中心。
 * 统一语义：目标键注册失败时先回滚到上一个可用键（或默认键），再进入定时重试；
 * 重试成功、或任何一次 apply 改变当前键，都会通过 onChange 通知调用方同步状态。
 */
class HotkeyRegistry {
  private readonly configs = new Map<HotkeySlot, SlotConfig>()
  private readonly states = new Map<HotkeySlot, SlotState>()
  private readonly listeners = new Set<ChangeListener>()
  private timer: NodeJS.Timeout | null = null

  configure(slot: HotkeySlot, config: SlotConfig): void {
    this.configs.set(slot, config)
    if (!this.states.has(slot)) {
      this.states.set(slot, { current: null, error: null, retryTarget: null })
    }
  }

  current(slot: HotkeySlot): string | null {
    return this.states.get(slot)?.current ?? null
  }

  error(slot: HotkeySlot): string | null {
    return this.states.get(slot)?.error ?? null
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 注册（或替换）目标快捷键；失败时回滚并进入重试队列 */
  apply(slot: HotkeySlot, target: string): SetHotkeyResult {
    const config = this.configs.get(slot)
    if (!config) return { ok: false, error: '快捷键未初始化' }
    const state = this.ensureState(slot)
    const next = target.trim() || config.fallback()
    if (state.current === next && globalShortcut.isRegistered(next)) {
      state.error = null
      this.clearRetry(slot)
      return { ok: true }
    }
    const previous = state.current
    if (previous && globalShortcut.isRegistered(previous)) globalShortcut.unregister(previous)
    if (tryRegister(next, config.handler)) {
      state.current = next
      state.error = null
      this.clearRetry(slot)
      this.emitChange(slot)
      return { ok: true }
    }
    // 统一回滚：优先恢复上一个可用键，其次默认键；都失败则当前无可用键
    const restore = previous ?? config.fallback()
    const restored = restore !== next && tryRegister(restore, config.handler)
    state.current = restored ? restore : null
    state.error = `快捷键 ${next} 注册失败，可能已被其它应用占用`
    state.retryTarget = next
    this.emitChange(slot)
    this.armTimer()
    return { ok: false, error: state.error }
  }

  /** 立即重试所有失败键（主窗重新可见时调用，不必等满一个周期） */
  retryFailed(): void {
    for (const slot of this.configs.keys()) {
      const state = this.states.get(slot)
      const target = state?.retryTarget
      if (target) this.apply(slot, target)
    }
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.listeners.clear()
    globalShortcut.unregisterAll()
  }

  private ensureState(slot: HotkeySlot): SlotState {
    const existing = this.states.get(slot)
    if (existing) return existing
    const created: SlotState = { current: null, error: null, retryTarget: null }
    this.states.set(slot, created)
    return created
  }

  private emitChange(slot: HotkeySlot): void {
    for (const listener of this.listeners) listener(slot)
  }

  private clearRetry(slot: HotkeySlot): void {
    const state = this.states.get(slot)
    if (state) state.retryTarget = null
    const othersPending = [...this.states.values()].some((entry) => entry.retryTarget !== null)
    if (othersPending || !this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  private armTimer(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.retryFailed(), RETRY_INTERVAL_MS)
  }
}

export const hotkeyRegistry = new HotkeyRegistry()
