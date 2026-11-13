import type { SetHotkeyResult } from './settings'

/** 贴图窗与主进程之间的通道 */
export const PIN_WINDOW_CHANNELS = {
  pinMeta: 'snip:pin-meta',
  pinReady: 'snip:pin-ready',
  pinClose: 'snip:pin-close',
  pinDragStart: 'snip:pin-drag-start',
  pinDragMove: 'snip:pin-drag-move',
  pinDragEnd: 'snip:pin-drag-end',
  pinResizeStart: 'snip:pin-resize-start',
  pinResizeMove: 'snip:pin-resize-move',
  pinResizeEnd: 'snip:pin-resize-end',
  pinCopy: 'snip:pin-copy',
  pinSave: 'snip:pin-save',
  pinThumbnail: 'snip:pin-thumbnail',
} as const

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
  /** 输出标注版 PNG（已合成笔迹）到剪贴板 */
  copy(png: ArrayBuffer): Promise<SetHotkeyResult>
  /** 输出标注版 PNG（已合成笔迹）另存为文件 */
  save(png: ArrayBuffer): Promise<SetHotkeyResult>
  /** 回传已合成笔迹的缩略图，供贴图列表展示 */
  thumbnail(png: ArrayBuffer): void
}
