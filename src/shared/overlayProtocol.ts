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
