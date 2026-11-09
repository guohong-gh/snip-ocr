import type { UpdateAdapter, UpdateAdapterEvent } from './updateAdapter'

/**
 * 自检专用假适配器：不 import electron-updater、不联网、不读写文件。
 * 事件由自检脚本主动 emit，故只在 `--selftest` 下被动态加载。
 */
const listeners = new Set<(event: UpdateAdapterEvent) => void>()

export const selftestUpdateCalls = {
  checks: 0,
  downloads: 0,
  cancels: 0,
  installs: 0,
}

export const selftestUpdateAdapter: UpdateAdapter = {
  check: async () => {
    selftestUpdateCalls.checks += 1
    // 模拟一次网络往返回合，让「并发检查单飞」可被稳定观测
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  },
  download: async () => {
    selftestUpdateCalls.downloads += 1
  },
  cancel: async () => {
    selftestUpdateCalls.cancels += 1
    emitSelftestUpdateEvent({ type: 'cancelled' })
  },
  install: async () => {
    selftestUpdateCalls.installs += 1
  },
  subscribe: (listener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}

export function emitSelftestUpdateEvent(event: UpdateAdapterEvent): void {
  for (const listener of [...listeners]) listener(event)
}

export function resetSelftestUpdateCalls(): void {
  selftestUpdateCalls.checks = 0
  selftestUpdateCalls.downloads = 0
  selftestUpdateCalls.cancels = 0
  selftestUpdateCalls.installs = 0
}
