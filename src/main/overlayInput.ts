import type { WebContents } from 'electron'
import type Screenshots from 'electron-screenshots'
import { hideOverlaySidebar } from './overlayUi'

export interface EscapeDeps {
  isLongShotActive(): boolean
  closeLongShot(): Promise<void>
  emitCancelled(): void
  finalizeCapture(): void
}

/** Esc 的优先级：先收侧栏，再取消长图，最后关闭截图 */
export async function handleEscape(
  lib: Screenshots,
  contents: WebContents,
  deps: EscapeDeps,
): Promise<void> {
  let sidebarOpen = false
  try {
    sidebarOpen = (await contents.executeJavaScript(
      `Boolean(document.getElementById('snip-ocr-sidebar')?.classList.contains('show'))`,
    )) as boolean
  } catch {
    sidebarOpen = false
  }
  if (sidebarOpen) {
    await hideOverlaySidebar(contents).catch(() => undefined)
    return
  }
  if (deps.isLongShotActive()) {
    await deps.closeLongShot()
    return
  }
  await lib.endCapture()
  deps.emitCancelled()
  deps.finalizeCapture()
}
