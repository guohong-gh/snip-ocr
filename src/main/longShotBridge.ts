import type { BrowserWindow, WebContents } from 'electron'
import {
  LongShotController,
  type LongShotDeps,
  type OcrResultPayload,
} from './longShot'
import type { CaptureOutcome } from './screenshot'
import type { CaptureSize } from './captureOutcome'

export interface LongShotBridgeHost {
  view(): WebContents | null
  overlayWindow(): BrowserWindow | null
  notify(title: string, body: string): void
  emitOutcome(outcome: CaptureOutcome): void
  emptySize(): CaptureSize
  endCapture(): Promise<void>
  emitCaptureEnded(): void
  isDisposed(): boolean
  setCapturing(capturing: boolean): void
  sendOcrResult(contents: WebContents, payload: OcrResultPayload): void
  tryStartOcr(): boolean
  endOcr(): void
}

/** 把截图服务的回调映射成 LongShotController 的依赖，避免长图模块反向持有截图服务 */
export function createLongShotBridge(host: LongShotBridgeHost): LongShotController {
  const deps: LongShotDeps = {
    view: () => host.view(),
    overlayWindow: () => host.overlayWindow(),
    notify: (title, body) => host.notify(title, body),
    emitOutcome: (outcome) => host.emitOutcome(outcome),
    emptySize: () => host.emptySize(),
    endCapture: () => host.endCapture(),
    emitCaptureEnded: () => host.emitCaptureEnded(),
    isDisposed: () => host.isDisposed(),
    setCapturing: (capturing) => host.setCapturing(capturing),
    sendOcrResult: (contents, payload) => host.sendOcrResult(contents, payload),
    tryStartOcr: () => host.tryStartOcr(),
    endOcr: () => host.endOcr(),
  }
  return new LongShotController(deps)
}
