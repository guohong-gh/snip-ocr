import type { HistoryLimit } from './history'

/** 主窗与主进程之间的设置类通道 */
export const SETTINGS_CHANNELS = {
  getState: 'snip:get-state',
  stateChanged: 'snip:state-changed',
  setHotkey: 'snip:set-hotkey',
  setPinHotkey: 'snip:set-pin-hotkey',
  setAutostart: 'snip:set-autostart',
  setIconTheme: 'snip:set-icon-theme',
  pickCustomIcon: 'snip:pick-custom-icon',
} as const

export const DEFAULT_HOTKEY = 'Alt+A'
export const DEFAULT_PIN_HOTKEY = 'Alt+P'

export const ICON_THEMES = ['default', 'deepseek', 'chibi', 'custom'] as const

export type IconTheme = (typeof ICON_THEMES)[number]

export interface SnipState {
  /** 当前生效的截图快捷键 */
  hotkey: string
  /** 上次保存截图快捷键失败的原因（被其它应用占用等） */
  hotkeyError: string | null
  /** 当前生效的贴图快捷键（贴最近一张截图，来自截图历史最新一条） */
  pinHotkey: string
  pinHotkeyError: string | null
  iconTheme: IconTheme
  /** 自定义图标 data URL，供设置页预览 */
  customIconUrl: string | null
  /** 开机自启当前状态 */
  autostart: boolean
  /** 当前是否支持开机自启（仅安装版） */
  autostartSupported: boolean
  /** 当前贴图窗口数量 */
  pinCount: number
  /** 截图历史是否至少有一条（贴图快捷键可贴出的前提） */
  hasHistory: boolean
  /** 截图历史保留档位 */
  historyLimit: HistoryLimit
  /** 选定的 OCR 语言标签；空字符串表示跟随系统默认 */
  ocrLanguage: string
  version: string
  platform: string
  displayCount: number
}

export interface SetHotkeyResult {
  ok: boolean
  error?: string
}
