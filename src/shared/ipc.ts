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
  /** 当前生效的贴图快捷键（贴最近一次截图） */
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
  /** 是否存在可再次贴图的上一次截图 */
  hasLastCapture: boolean
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

export interface PinHistoryItem {
  id: string
  /** 创建时间（毫秒时间戳） */
  createdAt: number
  /** 原始截图像素宽高 */
  imageWidth: number
  imageHeight: number
  /** 缩略图 data URL，仅用于列表展示 */
  thumbUrl: string
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
  startCapture(): void
  pinLast(): void
  closeAllPins(): void
  listPinHistory(): Promise<PinHistoryItem[]>
  deletePinHistory(id: string): Promise<PinHistoryItem[]>
  clearPinHistory(): Promise<PinHistoryItem[]>
  pinFromHistory(id: string): Promise<SetHotkeyResult>
  windowAction(action: HomeWindowAction): void
  quit(): void
  ready(): void
  onOpenSettings(listener: () => void): () => void
  onStateChanged(listener: (state: SnipState) => void): () => void
  onPinHistoryChanged(listener: () => void): () => void
  pin: PinApi
}
