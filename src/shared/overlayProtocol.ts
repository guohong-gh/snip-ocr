/**
 * 遮罩页只能通过 console 前缀与主进程通信。
 * 这里集中协议常量与解析逻辑，避免前缀字符串在多处复制。
 */

export const OVERLAY_ACTION_PREFIX = '__SNIP_ACTION__'
export const OVERLAY_COPY_PREFIX = '__SNIP_COPY__'
export const OVERLAY_HUD_RECT_PREFIX = '__SNIP_HUD_RECT__'
/** 侧栏「译成中文」请求（后接 base64 文本） */
export const OVERLAY_TRANSLATE_PREFIX = '__SNIP_TRANSLATE__'
export const OVERLAY_TRANSLATE_STATUS_PREFIX = '__SNIP_TRANSLATE_STATUS__'

/**
 * 遮罩页贴图请求位：库的「复制到剪贴板」按钮没有独立的贴图回调，
 * 注入脚本在点击前置 true，主进程在结果回调里读取并复位。
 * 页面脚本与主进程共用这一个键名，避免各写一份。
 */
export const OVERLAY_PIN_REQUEST_KEY = '__snipPinRequest'

/**
 * electron-screenshots 的 preload 把 `on(name)` 映射为 `SCREENSHOTS:<name>`。
 * 回送名在这里定义一份，主进程发完整通道名、注入脚本发页内名字，避免两处各写一份。
 */
const OVERLAY_REPLY_PREFIX = 'SCREENSHOTS:'

/** 遮罩页通过 window.screenshots.on(name) 监听的名字 */
export const OVERLAY_REPLY_NAMES = {
  ocrResult: 'ocr-result',
  translateStatus: 'translate-status',
  translateResult: 'translate-result',
} as const

/** 主进程 webContents.send 使用的完整通道名 */
export const OVERLAY_REPLY_CHANNELS = {
  ocrResult: `${OVERLAY_REPLY_PREFIX}${OVERLAY_REPLY_NAMES.ocrResult}`,
  translateStatus: `${OVERLAY_REPLY_PREFIX}${OVERLAY_REPLY_NAMES.translateStatus}`,
  translateResult: `${OVERLAY_REPLY_PREFIX}${OVERLAY_REPLY_NAMES.translateResult}`,
} as const

/** 遮罩页可发送的全部动作 */
export const OVERLAY_ACTIONS = [
  'ocr',
  'longshot',
  'longshot-finish',
  'longshot-copy',
  'longshot-save',
  'longshot-ocr',
  'longshot-close',
  'longshot-cancel',
] as const

export type OverlayAction = (typeof OVERLAY_ACTIONS)[number]

export interface OverlayActionMessage {
  action: OverlayAction
  requestId?: number
}

export type OverlayConsoleMessage =
  | { kind: 'hud'; payload: string }
  | { kind: 'copy'; encoded: string }
  | { kind: 'translate'; encoded: string }
  | { kind: 'translate-status'; payload: string }
  | { kind: 'action'; action: OverlayAction; requestId?: number }
  | { kind: 'unknown'; raw: string }

export function isOverlayAction(value: string): value is OverlayAction {
  return (OVERLAY_ACTIONS as readonly string[]).includes(value)
}

/** 解析动作载荷；未知动作、非法 JSON、非法 requestId 都被丢弃 */
export function parseOverlayAction(raw: string): OverlayActionMessage | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const candidate = value as { action?: unknown; requestId?: unknown }
  if (typeof candidate.action !== 'string' || !isOverlayAction(candidate.action)) return null
  const requestId =
    typeof candidate.requestId === 'number' && Number.isFinite(candidate.requestId)
      ? candidate.requestId
      : undefined
  return { action: candidate.action, requestId }
}

/** 按前缀把 console 消息分流；无法识别或动作非法时返回 unknown */
export function parseOverlayConsoleMessage(message: string): OverlayConsoleMessage {
  if (message.startsWith(OVERLAY_HUD_RECT_PREFIX)) {
    return { kind: 'hud', payload: message.slice(OVERLAY_HUD_RECT_PREFIX.length) }
  }
  if (message.startsWith(OVERLAY_COPY_PREFIX)) {
    return { kind: 'copy', encoded: message.slice(OVERLAY_COPY_PREFIX.length) }
  }
  if (message.startsWith(OVERLAY_TRANSLATE_STATUS_PREFIX)) {
    return {
      kind: 'translate-status',
      payload: message.slice(OVERLAY_TRANSLATE_STATUS_PREFIX.length),
    }
  }
  if (message.startsWith(OVERLAY_TRANSLATE_PREFIX)) {
    return { kind: 'translate', encoded: message.slice(OVERLAY_TRANSLATE_PREFIX.length) }
  }
  if (message.startsWith(OVERLAY_ACTION_PREFIX)) {
    const parsed = parseOverlayAction(message.slice(OVERLAY_ACTION_PREFIX.length))
    return parsed ? { kind: 'action', ...parsed } : { kind: 'unknown', raw: message }
  }
  return { kind: 'unknown', raw: message }
}
