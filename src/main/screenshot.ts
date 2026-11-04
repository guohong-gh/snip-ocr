import {
  app,
  clipboard,
  globalShortcut,
  nativeImage,
  Notification,
  screen,
  type BrowserWindow,
  type Display,
  type WebContents,
} from 'electron'
import Screenshots, { type Bounds } from 'electron-screenshots'
import { join } from 'node:path'
import { DEFAULT_HOTKEY, type IconTheme } from '@shared/ipc'
import { ocrService } from './ocr'
import {
  captureOverlayRect,
  captureOverlaySelection,
  hideOverlaySidebar,
  installOverlayUi,
  OVERLAY_ACTION_PREFIX,
  OVERLAY_COPY_PREFIX,
  updateOverlayTheme,
} from './overlayUi'
import { pinService, type PinCaptureInput } from './pin'
import { stitchVertical } from './stitch'

/** 被屏蔽的标注按钮的 title 哨兵，配合 CSS 隐藏 */
const DISABLED_TITLE = '__disabled__'

/** 库自带按钮的 title 只用于程序化触发；真实 UI 由 overlayUi 注入 */
const TOOLBAR_LANG = {
  magnifier_position_label: '坐标',
  operation_ok_title: '复制到剪贴板',
  operation_save_title: '保存为文件',
  operation_cancel_title: '关闭',
  operation_redo_title: DISABLED_TITLE,
  operation_undo_title: DISABLED_TITLE,
  operation_mosaic_title: DISABLED_TITLE,
  operation_text_title: DISABLED_TITLE,
  operation_brush_title: DISABLED_TITLE,
  operation_arrow_title: DISABLED_TITLE,
  operation_ellipse_title: DISABLED_TITLE,
  operation_rectangle_title: DISABLED_TITLE,
}

interface LibraryEvent {
  preventDefault(): void
}

export interface CaptureOutcome {
  kind: 'copied' | 'saved' | 'cancelled' | 'pinned'
  /** 裁剪结果的实际像素尺寸（已含 DPI 倍率） */
  width: number
  height: number
  /** 选区在屏幕上的 DIP 尺寸，用于校验 width/height ≈ DIP × scaleFactor */
  selectionWidth: number
  selectionHeight: number
  /** 选区相对显示器原点的 DIP 偏移，用于校验贴图位置 */
  selectionX: number
  selectionY: number
}

type OutcomeListener = (outcome: CaptureOutcome) => void

interface MaskAction {
  action: string
  requestId?: number
}

interface CaptureIpcData {
  bounds: Bounds
  display: Bounds & { id: number; scaleFactor: number }
}

/** 长截图会话：固定选区 + 已采集的帧（按采集顺序） */
interface LongShotSession {
  /** 选区 DIP，相对显示器原点；所有段都按这个矩形裁切 */
  bounds: Bounds
  display: Display
  frames: Buffer[]
}

class ScreenshotService {
  private lib: Screenshots | null = null
  private hotkey: string | null = null
  private capturing = false
  private listeners = new Set<OutcomeListener>()
  private beforeCaptureListeners = new Set<() => void>()
  private captureEndedListeners = new Set<() => void>()
  private overlayInstalled = false
  private overlayReady: Promise<void> | null = null
  private overlayReadyResolve: (() => void) | null = null
  private ocrRunning = false
  private disposed = false
  private theme: IconTheme = 'default'
  private customIconUrl: string | null = null
  private lastCapture: PinCaptureInput | null = null
  private longShot: LongShotSession | null = null

  onOutcome(listener: OutcomeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onBeforeCapture(listener: () => void): () => void {
    this.beforeCaptureListeners.add(listener)
    return () => this.beforeCaptureListeners.delete(listener)
  }

  onCaptureEnded(listener: () => void): () => void {
    this.captureEndedListeners.add(listener)
    return () => this.captureEndedListeners.delete(listener)
  }

  get isCapturing(): boolean {
    return this.capturing
  }

  get currentHotkey(): string | null {
    return this.hotkey
  }

  get lastPinCapture(): PinCaptureInput | null {
    return this.lastCapture
  }

  /** 截图视图（仅用于自检脚本读取 DOM / 注入输入事件） */
  get view(): WebContents | null {
    return this.lib?.$view.webContents ?? null
  }

  async setToolbarTheme(theme: IconTheme, customIconUrl: string | null): Promise<void> {
    this.theme = theme
    this.customIconUrl = customIconUrl
    if (this.overlayInstalled && this.view && !this.view.isDestroyed()) {
      await updateOverlayTheme(this.view, theme, customIconUrl).catch(() => undefined)
    }
  }

  private emit(outcome: CaptureOutcome): void {
    for (const listener of this.listeners) listener(outcome)
  }

  private emitCaptureEnded(): void {
    for (const listener of this.captureEndedListeners) listener()
  }

  private notify(title: string, body: string): void {
    if (!Notification.isSupported()) return
    new Notification({ title, body }).show()
  }

  private emptySize(): Pick<
    CaptureOutcome,
    'width' | 'height' | 'selectionWidth' | 'selectionHeight' | 'selectionX' | 'selectionY'
  > {
    return { width: 0, height: 0, selectionWidth: 0, selectionHeight: 0, selectionX: 0, selectionY: 0 }
  }

  private sizeOf(buffer: Buffer, data: CaptureIpcData): Pick<CaptureOutcome, 'width' | 'height' | 'selectionWidth' | 'selectionHeight' | 'selectionX' | 'selectionY'> {
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

  private ensureLib(): Screenshots {
    if (this.lib) return this.lib
    // 复用遮罩窗口，避免每次截图都新建 BrowserWindow
    const lib = new Screenshots({ lang: TOOLBAR_LANG, singleWindow: true })
    this.bindView(lib)
    this.lib = lib
    return lib
  }

  private bindView(lib: Screenshots): void {
    const contents = lib.$view.webContents
    this.overlayReady = new Promise((resolve) => {
      this.overlayReadyResolve = resolve
    })

    contents.on('dom-ready', () => {
      void installOverlayUi(contents, this.theme, this.customIconUrl)
        .then(() => {
          this.overlayInstalled = true
        })
        .catch((error) => console.error('[snip] overlay ui install failed:', error))
        .finally(() => {
          this.overlayReadyResolve?.()
          this.overlayReadyResolve = null
        })
    })

    lib.on('windowCreated', (win: BrowserWindow) => {
      // singleWindow 下遮罩是隐藏而不是销毁，用 hide 事件收尾
      win.on('hide', () => this.finalizeCapture())
    })

    contents.on('console-message', (_event, _level, message) => {
      if (message.includes('[snip-overlay-error]')) console.error('[overlay-console]', message)
      this.handleOverlayMessage(contents, message)
    })

    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'Escape') return
      event.preventDefault()
      void this.handleEscape(lib, contents)
    })

    lib.on('ok', (event: LibraryEvent, buffer: Buffer, data: CaptureIpcData) => {
      // 接管默认行为：确定与双击复制都从同一份裁剪 buffer 出发
      event.preventDefault()
      void this.finishOk(contents, buffer, data)
    })
    lib.on('save', (event: LibraryEvent, buffer: Buffer, data: CaptureIpcData) => {
      if (this.longShot) {
        // MVP 不支持拼接图另存为：拦下库的写盘，避免保存成单段画面
        event.preventDefault()
        this.notify('长截图', '长截图结果暂不支持另存为，请用「确定」复制或「贴图」')
        return
      }
      // 不 preventDefault：库的默认行为会弹出系统保存对话框并写 PNG，收尾由窗口 hide 触发
      this.lastCapture = { buffer, bounds: data.bounds, display: data.display }
      this.emit({ kind: 'saved', ...this.sizeOf(buffer, data) })
    })
    lib.on('cancel', () => {
      const wasCapturing = this.capturing
      this.longShot = null
      this.emit({ kind: 'cancelled', ...this.emptySize() })
      if (wasCapturing) this.finalizeCapture()
      else this.emitCaptureEnded()
    })
    lib.on('windowClosed', () => {
      this.finalizeCapture()
    })
  }

  private handleOverlayMessage(contents: WebContents, message: string): void {
    if (message.startsWith(OVERLAY_COPY_PREFIX)) {
      const encoded = message.slice(OVERLAY_COPY_PREFIX.length)
      try {
        const text = Buffer.from(encoded, 'base64').toString('utf8')
        if (text) clipboard.writeText(text)
      } catch {
        // 非法 base64 忽略
      }
      return
    }
    if (!message.startsWith(OVERLAY_ACTION_PREFIX)) return
    let action: MaskAction | null = null
    try {
      action = JSON.parse(message.slice(OVERLAY_ACTION_PREFIX.length)) as MaskAction
    } catch {
      return
    }
    if (action?.action === 'longshot') {
      void this.handleLongShotAction(contents)
      return
    }
    if (action?.action === 'ocr') {
      if (this.longShot) {
        this.sendOcrResult(contents, {
          requestId: action.requestId ?? Date.now(),
          status: 'error',
          text: '',
          language: '',
          error: '长截图模式下暂不支持 OCR',
        })
        return
      }
      void this.runOcr(contents, action.requestId ?? Date.now())
    }
  }

  private async runOcr(contents: WebContents, requestId: number): Promise<void> {
    if (this.ocrRunning) return
    this.ocrRunning = true
    try {
      const buffer = await captureOverlaySelection(contents)
      if (!buffer) {
        this.sendOcrResult(contents, { requestId, status: 'empty', text: '', language: '', error: '请先框选区域' })
        return
      }
      const result = await ocrService.recognize(buffer)
      if (!result.text) {
        this.sendOcrResult(contents, { requestId, status: 'empty', text: '', language: '', error: '未识别到文字' })
        return
      }
      this.sendOcrResult(contents, {
        requestId,
        status: 'ready',
        text: result.text,
        language: result.language,
        error: null,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[snip] ocr failed:', error)
      this.sendOcrResult(contents, { requestId, status: 'error', text: '', language: '', error: message })
    } finally {
      this.ocrRunning = false
    }
  }

  private sendOcrResult(
    contents: WebContents,
    payload: {
      requestId: number
      status: 'ready' | 'empty' | 'error'
      text: string
      language: string
      error: string | null
    },
  ): void {
    if (contents.isDestroyed()) return
    contents.send('SCREENSHOTS:ocr-result', payload)
  }

  private async handleEscape(lib: Screenshots, contents: WebContents): Promise<void> {
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
    this.longShot = null
    await lib.endCapture()
    this.emit({ kind: 'cancelled', ...this.emptySize() })
    this.finalizeCapture()
  }

  private async consumePinRequest(contents: WebContents): Promise<boolean> {
    try {
      const requested = (await contents.executeJavaScript(
        'window.__snipPinRequest === true',
      )) as unknown
      if (requested === true) {
        await contents.executeJavaScript('window.__snipPinRequest = false')
      }
      return requested === true
    } catch {
      return false
    }
  }

  private async finishOk(contents: WebContents, buffer: Buffer, data: CaptureIpcData): Promise<void> {
    const pinRequest = await this.consumePinRequest(contents)
    const session = this.longShot
    let finalBuffer = buffer
    let finalData = data
    if (session) {
      try {
        const stitched = stitchVertical(session.frames)
        finalBuffer = stitched.buffer
        finalData = {
          bounds: {
            x: data.bounds.x,
            y: data.bounds.y,
            width: session.bounds.width,
            height: stitched.height / data.display.scaleFactor,
          },
          display: data.display,
        }
      } catch (error) {
        this.longShot = null
        const message = error instanceof Error ? error.message : String(error)
        console.error('[snip] long screenshot stitch failed:', error)
        this.notify('长截图拼接失败', message)
        this.emit({ kind: 'cancelled', ...this.emptySize() })
        await this.stopCapture()
        this.finalizeCapture()
        return
      }
      this.longShot = null
    }
    const size = this.sizeOf(finalBuffer, finalData)
    this.lastCapture = { buffer: finalBuffer, bounds: finalData.bounds, display: finalData.display }
    if (pinRequest) {
      // 先收起遮罩再贴图，避免两个窗口重叠闪烁
      await this.stopCapture()
      try {
        await pinService.createPin({
          buffer: finalBuffer,
          bounds: finalData.bounds,
          display: finalData.display,
        })
        this.emit({ kind: 'pinned', ...size })
        this.finalizeCapture()
        return
      } catch (error) {
        console.error('[snip] pin failed:', error)
      }
    }
    clipboard.writeImage(nativeImage.createFromBuffer(finalBuffer))
    this.emit({ kind: 'copied', ...size })
    await this.stopCapture()
    this.finalizeCapture()
  }

  /**
   * 在鼠标所在显示器开始截图。
   * 库内部用 screen.getDisplayNearestPoint(getCursorScreenPoint()) 取 DIP 边界，
   * 取图用 node-screenshots 的原生采集（按物理分辨率），所以多屏与高 DPI 下选区不会偏移。
   */
  async startCapture(): Promise<void> {
    if (this.capturing) return
    if (this.longShot) {
      await this.continueLongShot()
      return
    }
    const lib = this.ensureLib()
    for (const listener of this.beforeCaptureListeners) listener()
    this.capturing = true
    void lib.$view.webContents
      .executeJavaScript('window.__snipPinRequest = false; window.__snipHideSidebar?.()')
      .catch(() => undefined)
    try {
      await lib.startCapture()
    } catch (error) {
      this.capturing = false
      this.emit({ kind: 'cancelled', ...this.emptySize() })
      this.emitCaptureEnded()
      throw error
    }
  }

  /** 长图模式下再次按热键：重新取帧、自动重画上次选区、追加一段 */
  private async continueLongShot(): Promise<void> {
    const session = this.longShot
    if (!session) return
    const lib = this.ensureLib()
    const contents = lib.$view.webContents
    this.capturing = true
    void contents
      .executeJavaScript('window.__snipPinRequest = false; window.__snipHideSidebar?.()')
      .catch(() => undefined)
    let baseline = 0
    try {
      baseline = (await contents.executeJavaScript('window.__snipCaptureSeq || 0')) as number
    } catch {
      baseline = 0
    }
    try {
      await lib.startCapture()
    } catch (error) {
      this.longShot = null
      this.capturing = false
      this.notify('长截图失败', '无法获取屏幕画面，长截图已结束')
      this.emit({ kind: 'cancelled', ...this.emptySize() })
      this.emitCaptureEnded()
      throw error
    }

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    if (display.id !== session.display.id) {
      this.longShot = null
      this.notify('长截图已结束', '显示器发生变化，请重新开始')
      this.emit({ kind: 'cancelled', ...this.emptySize() })
      this.finalizeCapture()
      return
    }

    await this.waitForCaptureFrame(contents, baseline)
    const restored = await this.restoreLongSelection(contents, session.bounds)
    if (!restored) {
      this.longShot = null
      this.notify('长截图已结束', '无法恢复上次选区，请重新开始')
      this.emit({ kind: 'cancelled', ...this.emptySize() })
      this.finalizeCapture()
      return
    }
    const buffer = await captureOverlayRect(contents, session.bounds)
    if (buffer) {
      session.frames.push(buffer)
    } else {
      console.error('[snip] long screenshot segment crop failed')
    }
    await this.setLongShotIndicator(contents, session.frames.length)
  }

  /** 入口动作：首次点击记录选区并收起遮罩；已在长图态则视为「继续」 */
  private async handleLongShotAction(contents: WebContents): Promise<void> {
    if (this.longShot) {
      await this.stopCapture()
      return
    }
    const bounds = await this.readOverlaySelection(contents)
    if (!bounds) return
    const buffer = await captureOverlayRect(contents, bounds)
    if (!buffer) return
    this.longShot = {
      bounds,
      display: screen.getDisplayNearestPoint(screen.getCursorScreenPoint()),
      frames: [buffer],
    }
    await this.setLongShotIndicator(contents, 1)
    await this.stopCapture()
  }

  /** 读取当前 canvas 选区（DIP，相对遮罩视口） */
  private async readOverlaySelection(contents: WebContents): Promise<Bounds | null> {
    try {
      const rect = (await contents.executeJavaScript(
        `(() => {
          const canvas = document.querySelector('.screenshots-canvas');
          if (!canvas) return null;
          const r = canvas.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return null;
          return {
            x: Math.round(r.left),
            y: Math.round(r.top),
            width: Math.round(r.width),
            height: Math.round(r.height),
          };
        })()`,
      )) as Bounds | null
      if (!rect) return null
      if (
        !Number.isFinite(rect.x) ||
        !Number.isFinite(rect.y) ||
        !Number.isFinite(rect.width) ||
        !Number.isFinite(rect.height)
      ) {
        return null
      }
      return rect
    } catch {
      return null
    }
  }

  /** 等遮罩收到新一轮 capture 且背景图解码完成 */
  private async waitForCaptureFrame(contents: WebContents, baseline: number): Promise<void> {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      try {
        const state = (await contents.executeJavaScript(
          `(() => {
            const image = document.querySelector('.screenshots-background-image');
            return {
              seq: window.__snipCaptureSeq || 0,
              ready: Boolean(image && image.naturalWidth > 0),
            };
          })()`,
        )) as { seq: number; ready: boolean } | null
        if (state && state.seq > baseline && state.ready) return
      } catch {
        // 页面重建瞬间忽略
      }
      await sleep(50)
    }
  }

  /** 用合成拖拽把上次选区画回来（库没有恢复选区的公开 API） */
  private async restoreLongSelection(contents: WebContents, bounds: Bounds): Promise<boolean> {
    const viewport = (await contents.executeJavaScript(
      '({ width: window.innerWidth, height: window.innerHeight })',
    )) as { width: number; height: number }
    const x0 = Math.max(0, Math.round(bounds.x))
    const y0 = Math.max(0, Math.round(bounds.y))
    const x1 = Math.min(Math.max(1, viewport.width - 1), Math.round(bounds.x + bounds.width - 1))
    const y1 = Math.min(Math.max(1, viewport.height - 1), Math.round(bounds.y + bounds.height - 1))
    if (x1 - x0 < 2 || y1 - y0 < 2) return false

    contents.sendInputEvent({ type: 'mouseMove', x: x0, y: y0 })
    await sleep(30)
    contents.sendInputEvent({ type: 'mouseDown', x: x0, y: y0, button: 'left', clickCount: 1 })
    const steps = 8
    for (let step = 1; step <= steps; step += 1) {
      contents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(x0 + ((x1 - x0) * step) / steps),
        y: Math.round(y0 + ((y1 - y0) * step) / steps),
      })
      await sleep(20)
    }
    contents.sendInputEvent({ type: 'mouseUp', x: x1, y: y1, button: 'left', clickCount: 1 })
    await sleep(400)

    const deadline = Date.now() + 1500
    while (Date.now() < deadline) {
      try {
        const rect = (await contents.executeJavaScript(
          `(() => {
            const canvas = document.querySelector('.screenshots-canvas');
            if (!canvas) return null;
            const r = canvas.getBoundingClientRect();
            return { x: r.left, y: r.top, width: r.width, height: r.height };
          })()`,
        )) as Bounds | null
        if (
          rect &&
          Math.abs(rect.x - bounds.x) <= 1 &&
          Math.abs(rect.y - bounds.y) <= 1 &&
          Math.abs(rect.width - bounds.width) <= 2 &&
          Math.abs(rect.height - bounds.height) <= 2
        ) {
          return true
        }
      } catch {
        // 页面重建瞬间忽略
      }
      await sleep(80)
    }
    return false
  }

  private async setLongShotIndicator(contents: WebContents, count: number): Promise<void> {
    await contents.executeJavaScript(`window.__snipSetLongShot?.(${count})`).catch(() => undefined)
  }

  /** 预热遮罩页，避免第一次截图才加载页面/注入 UI */
  async prewarm(): Promise<void> {
    this.ensureLib()
    if (!this.overlayReady) return
    await Promise.race([
      this.overlayReady,
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ])
  }

  async stopCapture(): Promise<void> {
    const lib = this.lib
    if (!lib) return
    await lib.endCapture()
  }

  private finalizeCapture(): void {
    if (!this.capturing) return
    this.capturing = false
    // 长图会话只是暂隐遮罩，不算截图结束：不重开主窗、不广播结束
    if (this.longShot) return
    if (!this.disposed) this.emitCaptureEnded()
  }

  private register(accelerator: string): boolean {
    try {
      return globalShortcut.register(accelerator, () => void this.startCapture().catch(onShortcutError))
    } catch {
      return false
    }
  }

  /** 注册（或替换）全局快捷键，失败时回滚到上一个可用值 */
  setHotkey(accelerator: string): { ok: boolean; error?: string } {
    const next = accelerator.trim() || DEFAULT_HOTKEY
    if (this.hotkey === next) return { ok: true }
    const previous = this.hotkey
    if (previous) globalShortcut.unregister(previous)
    if (!this.register(next)) {
      const fallback = previous ?? DEFAULT_HOTKEY
      this.hotkey = this.register(fallback) ? fallback : null
      return { ok: false, error: `快捷键 ${next} 注册失败，可能已被其它应用占用` }
    }
    this.hotkey = next
    return { ok: true }
  }

  dispose(): void {
    this.disposed = true
    globalShortcut.unregisterAll()
  }
}

function onShortcutError(error: unknown): void {
  console.error('[snip] capture failed:', error)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export const screenshotService = new ScreenshotService()

export function trayIconPath(): string {
  return join(app.getAppPath(), 'assets', process.platform === 'win32' ? 'tray.ico' : 'tray.png')
}
