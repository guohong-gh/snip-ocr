import { registerAppWindowIpc, type AppWindowIpcHandlers } from './appWindow'
import { registerHistoryIpc, type HistoryIpcHandlers } from './history'
import { registerOcrIpc } from './ocr'
import { registerPinWindowIpc } from './pinWindow'
import { registerSettingsIpc, type SettingsIpcHandlers } from './settings'
import { registerTranslateIpc } from './translate'

export interface IpcRegistry {
  settings: SettingsIpcHandlers
  history: HistoryIpcHandlers
  appWindow: AppWindowIpcHandlers
}

const registered: string[] = []

/** 组合根：按业务域注册全部 IPC 通道 */
export function registerIpc(registry: IpcRegistry): void {
  registered.push(
    ...registerSettingsIpc(registry.settings),
    ...registerHistoryIpc(registry.history),
    ...registerOcrIpc(),
    ...registerTranslateIpc(),
    ...registerPinWindowIpc(),
    ...registerAppWindowIpc(registry.appWindow),
  )
}

/** 供自检验证每个入站通道恰好注册一次 */
export function registeredIpcChannels(): string[] {
  return [...registered]
}
