/// <reference lib="dom" />
import { OVERLAY_PIN_REQUEST_KEY } from '@shared/overlayProtocol'

/** 遮罩页的贴图请求位；键名由 shared 协议定义，页面脚本与主进程共用 */
export interface OverlayPageWindow extends Window {
  __snipPinRequest?: boolean
}

/** 主进程侧：读取并复位贴图请求位，返回本次是否请求贴图 */
export function pinRequestConsumeScript(): string {
  const key = JSON.stringify(OVERLAY_PIN_REQUEST_KEY)
  return `(() => {
    const page = window;
    const requested = page[${key}] === true;
    if (requested) page[${key}] = false;
    return requested;
  })()`
}

/** 主进程侧：复位贴图请求位，防止上一次的残留影响下一次截图 */
export function pinRequestResetScript(): string {
  return `window[${JSON.stringify(OVERLAY_PIN_REQUEST_KEY)}] = false`
}
