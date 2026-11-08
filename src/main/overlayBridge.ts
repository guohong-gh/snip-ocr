import { app, type WebContents } from 'electron'
import { TRANSLATE_DIRECTIONS, type TranslateDirection } from '@shared/ipc'
import { OVERLAY_REPLY_CHANNELS, parseOverlayConsoleMessage } from '@shared/overlayProtocol'
import { translate, translateStatus } from './translate'

let registrations = 0

/** 仅供 testHooks 汇总给自检验证：翻译桥只注册一次，避免同一请求被多份监听重复处理 */
export function overlayBridgeRegistrationCount(): number {
  return registrations
}

/** 遮罩侧栏无法直接调 IPC，只能通过 console 前缀回传；这里统一桥接并回送结果 */
export function registerOverlayTranslateBridge(): void {
  if (registrations > 0) return
  registrations += 1
  app.on('web-contents-created', (_event, contents: WebContents) => {
    contents.on('console-message', (_event, _level, message) => {
      const parsed = parseOverlayConsoleMessage(message)
      if (parsed.kind === 'translate-status') {
        contents.send(OVERLAY_REPLY_CHANNELS.translateStatus, translateStatus())
        return
      }
      if (parsed.kind !== 'translate') return
      let text = ''
      let direction: TranslateDirection = 'en-zh'
      try {
        const decoded = Buffer.from(parsed.encoded, 'base64').toString('utf8')
        const payload = JSON.parse(decoded) as { text?: unknown; direction?: unknown }
        text = typeof payload.text === 'string' ? payload.text : ''
        if (
          typeof payload.direction === 'string' &&
          (TRANSLATE_DIRECTIONS as readonly string[]).includes(payload.direction)
        ) {
          direction = payload.direction as TranslateDirection
        }
      } catch {
        return
      }
      void translate(text, direction).then((result) => {
        if (!contents.isDestroyed()) contents.send(OVERLAY_REPLY_CHANNELS.translateResult, result)
      })
    })
  })
}
