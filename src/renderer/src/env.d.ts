/// <reference types="vite/client" />
import type { PinApi, PinListApi, SnipApi } from '@shared/ipc'

declare global {
  interface Window {
    /** 主窗 API */
    snip: SnipApi
    /** 贴图窗 API（仅 pin.html 暴露） */
    snipPin: PinApi
    /** 贴图列表面板 API（仅 pin-list.html 暴露） */
    snipPinList: PinListApi
  }
}

export {}
