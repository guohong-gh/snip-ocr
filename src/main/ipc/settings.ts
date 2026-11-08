import { ipcMain } from 'electron'
import {
  ICON_THEMES,
  IPC,
  type IconTheme,
  type SetHotkeyResult,
  type UpdateCheckResult,
} from '@shared/ipc'
import { buildState } from '../appState'

export interface SettingsIpcHandlers {
  applyHotkey(next: string): SetHotkeyResult
  applyPinHotkey(next: string): SetHotkeyResult
  setAutostart(enabled: boolean): SetHotkeyResult
  applyIconTheme(theme: IconTheme): Promise<SetHotkeyResult>
  pickCustomIcon(): Promise<SetHotkeyResult>
  checkUpdate(): Promise<UpdateCheckResult>
}

export function registerSettingsIpc(handlers: SettingsIpcHandlers): string[] {
  ipcMain.handle(IPC.getState, () => buildState())
  ipcMain.handle(IPC.setHotkey, (_event, accelerator: unknown) => {
    if (typeof accelerator !== 'string' || !accelerator.trim()) {
      return { ok: false, error: '快捷键不能为空' } satisfies SetHotkeyResult
    }
    return handlers.applyHotkey(accelerator)
  })
  ipcMain.handle(IPC.setPinHotkey, (_event, accelerator: unknown) => {
    if (typeof accelerator !== 'string' || !accelerator.trim()) {
      return { ok: false, error: '快捷键不能为空' } satisfies SetHotkeyResult
    }
    return handlers.applyPinHotkey(accelerator)
  })
  ipcMain.handle(IPC.setAutostart, (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return { ok: false, error: '参数无效' } satisfies SetHotkeyResult
    return handlers.setAutostart(enabled)
  })
  ipcMain.handle(IPC.setIconTheme, async (_event, theme: unknown) => {
    if (typeof theme !== 'string' || !(ICON_THEMES as readonly string[]).includes(theme)) {
      return { ok: false, error: '无效的图标主题' } satisfies SetHotkeyResult
    }
    return handlers.applyIconTheme(theme as IconTheme)
  })
  ipcMain.handle(IPC.pickCustomIcon, () => handlers.pickCustomIcon())
  ipcMain.handle(IPC.checkUpdate, () => handlers.checkUpdate())
  return [
    IPC.getState,
    IPC.setHotkey,
    IPC.setPinHotkey,
    IPC.setAutostart,
    IPC.setIconTheme,
    IPC.pickCustomIcon,
    IPC.checkUpdate,
  ]
}
