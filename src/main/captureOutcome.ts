import { clipboard, nativeImage } from 'electron'
import type { WebContents } from 'electron'
import type { Bounds } from 'electron-screenshots'
import { pinRequestConsumeScript } from './overlay/pinRequest'
import { pinService } from './pin'
import { recordPinHistory } from './pinHistory'
import type { CaptureOutcome } from './screenshot'

export type CaptureSize = Pick<
  CaptureOutcome,
  'width' | 'height' | 'selectionWidth' | 'selectionHeight' | 'selectionX' | 'selectionY'
>

export interface CaptureIpcData {
  bounds: Bounds
  display: Bounds & { id: number; scaleFactor: number }
}

export function emptySize(): CaptureSize {
  return { width: 0, height: 0, selectionWidth: 0, selectionHeight: 0, selectionX: 0, selectionY: 0 }
}

export function sizeOf(buffer: Buffer, data: CaptureIpcData): CaptureSize {
  const { width, height } = nativeImage.createFromBuffer(buffer).getSize()
  return {
    width,
    height,
    selectionWidth: Math.round(data.bounds.width),
    selectionHeight: Math.round(data.bounds.height),
    selectionX: Math.round(data.bounds.x),
    selectionY: Math.round(data.bounds.y),
  }
}

async function consumePinRequest(contents: WebContents): Promise<boolean> {
  try {
    const requested = (await contents.executeJavaScript(pinRequestConsumeScript())) as unknown
    return requested === true
  } catch {
    return false
  }
}

export interface FinishOkDeps {
  stopCapture(): Promise<void>
  finalizeCapture(): void
  emitOutcome(outcome: CaptureOutcome): void
  notify(title: string, body: string): void
}

export async function finishOk(
  contents: WebContents,
  buffer: Buffer,
  data: CaptureIpcData,
  deps: FinishOkDeps,
): Promise<void> {
  const pinRequest = await consumePinRequest(contents)
  const finalBuffer = buffer
  const finalData = data
  const size = sizeOf(finalBuffer, finalData)
  if (pinRequest) {
    // 先收起遮罩再贴图，避免两个窗口重叠闪烁
    await deps.stopCapture()
    try {
      await pinService.createPin({
        buffer: finalBuffer,
        bounds: finalData.bounds,
        display: finalData.display,
      })
      deps.emitOutcome({ kind: 'pinned', ...size })
      deps.finalizeCapture()
      return
    } catch (error) {
      console.error('[snip] pin failed:', error)
      // 贴图失败必须明确告知用户，不能静默回退为复制
      deps.notify('贴图失败', error instanceof Error ? error.message : String(error))
      deps.emitOutcome({ kind: 'cancelled', ...size })
      deps.finalizeCapture()
      return
    }
  }
  clipboard.writeImage(nativeImage.createFromBuffer(finalBuffer))
  void recordPinHistory(finalBuffer, size.width, size.height, 'copy')
  deps.emitOutcome({ kind: 'copied', ...size })
  await deps.stopCapture()
  deps.finalizeCapture()
}
