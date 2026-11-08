import type { WebContents } from 'electron'
import { OVERLAY_REPLY_CHANNELS } from '@shared/overlayProtocol'
import { ocrService } from './ocr'
import { captureOverlaySelection } from './overlayUi'
import type { OcrResultPayload } from './longShot'

export function sendOcrResult(contents: WebContents, payload: OcrResultPayload): void {
  if (contents.isDestroyed()) return
  contents.send(OVERLAY_REPLY_CHANNELS.ocrResult, payload)
}

/** 遮罩 OCR 调度：一次只跑一个识别，长图模块共用同一把锁 */
export class OverlayOcr {
  private running = false

  tryStart(): boolean {
    if (this.running) return false
    this.running = true
    return true
  }

  end(): void {
    this.running = false
  }

  async run(contents: WebContents, requestId: number): Promise<void> {
    if (!this.tryStart()) return
    try {
      const buffer = await captureOverlaySelection(contents)
      if (!buffer) {
        sendOcrResult(contents, { requestId, status: 'empty', text: '', language: '', error: '请先框选区域' })
        return
      }
      const result = await ocrService.recognize(buffer)
      if (!result.text) {
        sendOcrResult(contents, { requestId, status: 'empty', text: '', language: '', error: '未识别到文字' })
        return
      }
      sendOcrResult(contents, {
        requestId,
        status: 'ready',
        text: result.text,
        language: result.language,
        error: null,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[snip] ocr failed:', error)
      sendOcrResult(contents, { requestId, status: 'error', text: '', language: '', error: message })
    } finally {
      this.end()
    }
  }
}
