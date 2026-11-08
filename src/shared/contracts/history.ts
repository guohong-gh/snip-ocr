/** 截图历史通道 */
export const HISTORY_CHANNELS = {
  pinHistoryList: 'snip:pin-history-list',
  pinHistoryChanged: 'snip:pin-history-changed',
  pinHistoryDelete: 'snip:pin-history-delete',
  pinHistoryClear: 'snip:pin-history-clear',
  pinHistoryPin: 'snip:pin-history-pin',
  pinHistoryCopy: 'snip:pin-history-copy',
  pinHistorySave: 'snip:pin-history-save',
  setHistoryLimit: 'snip:set-history-limit',
} as const

/** 截图历史保留档位 */
export const HISTORY_LIMITS = [5, 10, 50] as const
export type HistoryLimit = (typeof HISTORY_LIMITS)[number]

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
