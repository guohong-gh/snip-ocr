export const IPC = {
  getState: 'snip:get-state',
  stateChanged: 'snip:state-changed',
  setHotkey: 'snip:set-hotkey',
  setPinHotkey: 'snip:set-pin-hotkey',
  setAutostart: 'snip:set-autostart',
  setIconTheme: 'snip:set-icon-theme',
  pickCustomIcon: 'snip:pick-custom-icon',
  checkUpdate: 'snip:check-update',
  homeStartCapture: 'snip:home-start-capture',
  homeWindowAction: 'snip:home-window-action',
  homeReady: 'snip:home-ready',
  homeOpenSettings: 'snip:home-open-settings',
  quitApp: 'snip:quit-app',
  pinLast: 'snip:pin-last',
  pinCloseAll: 'snip:pin-close-all',
  pinMeta: 'snip:pin-meta',
  pinReady: 'snip:pin-ready',
  pinClose: 'snip:pin-close',
  pinDragStart: 'snip:pin-drag-start',
  pinDragMove: 'snip:pin-drag-move',
  pinDragEnd: 'snip:pin-drag-end',
  pinResizeStart: 'snip:pin-resize-start',
  pinResizeMove: 'snip:pin-resize-move',
  pinResizeEnd: 'snip:pin-resize-end',
  pinHistoryList: 'snip:pin-history-list',
  pinHistoryChanged: 'snip:pin-history-changed',
  pinHistoryDelete: 'snip:pin-history-delete',
  pinHistoryClear: 'snip:pin-history-clear',
  pinHistoryPin: 'snip:pin-history-pin',
  pinHistoryCopy: 'snip:pin-history-copy',
  pinHistorySave: 'snip:pin-history-save',
  translateStatus: 'snip:translate-status',
  translateToChinese: 'snip:translate-to-chinese',
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
  version: string
  platform: string
  displayCount: number
}

export interface SetHotkeyResult {
  ok: boolean
  error?: string
}

export interface UpdateCheckResult {
  status: 'latest'
  version: string
}

export interface TranslateStatus {
  /** 插件是否已安装（exe 与 enzh 模型文件齐全） */
  available: boolean
  /** 插件目录绝对路径，未安装时用于提示放置位置 */
  pluginDir: string
}

/** 仅英译中：失败时保留原文由调用方（侧栏）决定 */
export type TranslateResult = { ok: true; text: string } | { ok: false; reason: string }

export const PIN_RESIZE_DIRECTIONS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const

export type PinResizeDirection = (typeof PIN_RESIZE_DIRECTIONS)[number]

export interface PinMeta {
  id: number
  /** 贴图内容区宽（DIP），应等于图片像素宽 / scaleFactor */
  contentWidth: number
  /** 贴图内容区高（DIP） */
  contentHeight: number
  imageWidth: number
  imageHeight: number
  scaleFactor: number
  alwaysOnTop: boolean
  resizable: boolean
}

/** 截图历史来源：复制 / 另存 / 贴图 / 长图 */
export const HISTORY_SOURCES = ['copy', 'save', 'pin', 'longshot'] as const
export type HistorySource = (typeof HISTORY_SOURCES)[number]

export interface PinHistoryItem {
  id: string
  /** 创建时间（毫秒时间戳） */
  createdAt: number
  /** 原始截图像素宽高 */
  imageWidth: number
  imageHeight: number
  /** 缩略图 data URL，仅用于列表展示 */
  thumbUrl: string
  /** 本次截图走的是哪个出口 */
  source: HistorySource
}

export interface PinApi {
  meta(): Promise<PinMeta | null>
  ready(): void
  close(): void
  dragStart(x: number, y: number): void
  dragMove(x: number, y: number): void
  dragEnd(): void
  resizeStart(direction: PinResizeDirection, x: number, y: number): void
  resizeMove(x: number, y: number): void
  resizeEnd(): void
}

export type HomeWindowAction = 'close' | 'minimize'

export interface SnipApi {
  getState(): Promise<SnipState>
  setHotkey(accelerator: string): Promise<SetHotkeyResult>
  setPinHotkey(accelerator: string): Promise<SetHotkeyResult>
  setAutostart(enabled: boolean): Promise<SetHotkeyResult>
  setIconTheme(theme: IconTheme): Promise<SetHotkeyResult>
  pickCustomIcon(): Promise<SetHotkeyResult>
  checkUpdate(): Promise<UpdateCheckResult>
  translateStatus(): Promise<TranslateStatus>
  translateToChinese(text: string): Promise<TranslateResult>
  startCapture(): void
  pinLast(): void
  closeAllPins(): void
  listPinHistory(): Promise<PinHistoryItem[]>
  deletePinHistory(id: string): Promise<PinHistoryItem[]>
  clearPinHistory(): Promise<PinHistoryItem[]>
  pinFromHistory(id: string): Promise<SetHotkeyResult>
  copyFromHistory(id: string): Promise<SetHotkeyResult>
  saveFromHistory(id: string): Promise<SetHotkeyResult>
  windowAction(action: HomeWindowAction): void
  quit(): void
  ready(): void
  onOpenSettings(listener: () => void): () => void
  onStateChanged(listener: (state: SnipState) => void): () => void
  onPinHistoryChanged(listener: () => void): () => void
  pin: PinApi
}
