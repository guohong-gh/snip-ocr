import { app, screen } from 'electron'
import {
  DEFAULT_HOTKEY,
  DEFAULT_PIN_HOTKEY,
  IPC,
  type HistoryLimit,
  type IconTheme,
  type SnipState,
} from '@shared/ipc'
import { getHomeWindow } from './homeWindow'
import { pinService } from './pin'

export interface AppState {
  hotkey: string
  hotkeyError: string | null
  pinHotkey: string
  pinHotkeyError: string | null
  iconTheme: IconTheme
  customIconUrl: string | null
  autostart: boolean
  /** 截图历史是否至少有一条（贴图快捷键与首页按钮的可用态都跟着它走） */
  hasHistory: boolean
  /** 截图历史保留档位（启动时从配置读取，切换时同步更新） */
  historyLimit: HistoryLimit
  /** 选定的 OCR 语言标签；空字符串表示跟随系统默认 */
  ocrLanguage: string
}

export const appState: AppState = {
  hotkey: DEFAULT_HOTKEY,
  hotkeyError: null,
  pinHotkey: DEFAULT_PIN_HOTKEY,
  pinHotkeyError: null,
  iconTheme: 'default',
  customIconUrl: null,
  autostart: false,
  hasHistory: false,
  historyLimit: 10,
  ocrLanguage: '',
}

export function buildState(): SnipState {
  return {
    hotkey: appState.hotkey,
    hotkeyError: appState.hotkeyError,
    pinHotkey: appState.pinHotkey,
    pinHotkeyError: appState.pinHotkeyError,
    iconTheme: appState.iconTheme,
    customIconUrl: appState.customIconUrl,
    autostart: appState.autostart,
    autostartSupported: app.isPackaged,
    pinCount: pinService.count,
    hasHistory: appState.hasHistory,
    historyLimit: appState.historyLimit,
    ocrLanguage: appState.ocrLanguage,
    version: app.getVersion(),
    platform: process.platform,
    displayCount: screen.getAllDisplays().length,
  }
}

export function broadcastState(): void {
  const win = getHomeWindow()
  if (win) win.webContents.send(IPC.stateChanged, buildState())
}
