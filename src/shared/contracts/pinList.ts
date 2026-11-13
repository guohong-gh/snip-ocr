/** 主窗贴图列表面板的通道 */
export const PIN_LIST_CHANNELS = {
  pinListGet: 'snip:pin-list-get',
  pinListChanged: 'snip:pin-list-changed',
  pinListToggle: 'snip:pin-list-toggle',
  pinListAction: 'snip:pin-list-action',
  pinListClose: 'snip:pin-list-close',
} as const

export type PinListAction = 'bringToFront' | 'hide' | 'show'

/** 列表项：来自主进程贴图实例，隐藏的贴图仍然在列表里 */
export interface PinSummary {
  id: number
  /** 已合成笔迹的缩略图 data URL；首帧回传前为 null */
  thumbUrl: string | null
  imageWidth: number
  imageHeight: number
  hidden: boolean
  alwaysOnTop: boolean
}

export interface PinListApi {
  list(): Promise<PinSummary[]>
  action(id: number, action: PinListAction): Promise<void>
  /** 收起面板（保留窗口实例，下次展开更快） */
  close(): void
  onChanged(listener: (pins: PinSummary[]) => void): () => void
}
