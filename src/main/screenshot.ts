import {
  app,
  clipboard,
  globalShortcut,
  nativeImage,
  Notification,
  type BrowserWindow,
  type WebContents,
} from 'electron'
import Screenshots, { type Bounds } from 'electron-screenshots'
import { join } from 'node:path'
import { DEFAULT_HOTKEY, type IconTheme } from '@shared/ipc'
import { ocrService } from './ocr'
import { LongShotController } from './longShot'
import {
  captureOverlaySelection,
  hideOverlaySidebar,
  installOverlayUi,
  updateOverlayTheme,
} from './overlayUi'
import { parseOverlayConsoleMessage } from '@shared/overlayProtocol'
import { pinService } from './pin'
import { recordPinHistory } from './pinHistory'

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

interface CaptureIpcData {
  bounds: Bounds
  display: Bounds & { id: number; scaleFactor: number }
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
  private readonly longShot = new LongShotController({
    view: () => this.view,
    overlayWindow: () => this.overlayWindow(),
    notify: (title, body) => this.notify(title, body),
    emitOutcome: (outcome) => this.emit(outcome),
    emptySize: () => this.emptySize(),
    endCapture: () => this.stopCapture(),
    emitCaptureEnded: () => this.emitCaptureEnded(),
    isDisposed: () => this.disposed,
    setCapturing: (capturing) => {
      this.capturing = capturing
    },
    sendOcrResult: (contents, payload) => this.sendOcrResult(contents, payload),
    tryStartOcr: () => {
      if (this.ocrRunning) return false
      this.ocrRunning = true
      return true
    },
    endOcr: () => {
      this.ocrRunning = false
    },
  })

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
      if (this.longShot.isActive() || this.longShot.hasResult()) {
        // 长图态下遮罩里没有可裁的选区，改用拼接结果走自己的保存流程
        event.preventDefault()
        void this.longShot.save()
        return
      }
      // 不 preventDefault：库的默认行为会弹出系统保存对话框并写 PNG，收尾由窗口 hide 触发
      const size = this.sizeOf(buffer, data)
      void recordPinHistory(buffer, size.width, size.height, 'save')
      this.emit({ kind: 'saved', ...size })
    })
    lib.on('cancel', () => {
      const wasCapturing = this.capturing
      if (this.longShot.isActive() || this.longShot.hasResult()) {
        void this.longShot.close(true)
        return
      }
      this.emit({ kind: 'cancelled', ...this.emptySize() })
      if (wasCapturing) this.finalizeCapture()
      else this.emitCaptureEnded()
    })
    lib.on('windowClosed', () => {
      this.finalizeCapture()
    })
  }

  private handleOverlayMessage(contents: WebContents, message: string): void {
    const parsed = parseOverlayConsoleMessage(message)
    switch (parsed.kind) {
      case 'hud':
        this.longShot.updateHudRects(parsed.payload)
        return
      case 'copy': {
        try {
          const text = Buffer.from(parsed.encoded, 'base64').toString('utf8')
          if (text) clipboard.writeText(text)
        } catch {
          // 非法 base64 忽略
        }
        return
      }
      case 'action':
        switch (parsed.action) {
          case 'longshot':
            void this.longShot.handleAction(contents)
            return
          case 'longshot-finish':
            void this.longShot.finish('manual')
            return
          case 'longshot-copy':
            this.longShot.copy()
            return
          case 'longshot-save':
            void this.longShot.save()
            return
          case 'longshot-ocr':
            void this.longShot.runOcr(contents, parsed.requestId ?? Date.now())
            return
          case 'longshot-close':
            void this.longShot.close()
            return
          case 'longshot-cancel':
            void this.longShot.close(true)
            return
          case 'ocr':
            void this.runOcr(contents, parsed.requestId ?? Date.now())
            return
          default:
            return
        }
      default:
        return
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
    if (this.longShot.isActive() || this.longShot.hasResult()) {
      // 长图态 Esc = 取消：不写剪贴板，下次从头开始
      await this.longShot.close(true)
      return
    }
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
    const finalBuffer = buffer
    const finalData = data
    const size = this.sizeOf(finalBuffer, finalData)
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
    void recordPinHistory(finalBuffer, size.width, size.height, 'copy')
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
    if (this.longShot.isActive()) {
      // 长图跟随中再按热键 = 立刻结束并复制当前结果
      await this.longShot.finish('manual')
      return
    }
    if (this.longShot.hasResult()) return
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

  private overlayWindow(): BrowserWindow | null {
    return (this.lib as (Screenshots & { $win?: BrowserWindow }) | null)?.$win ?? null
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
    if (this.longShot.isActive()) return
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

export const screenshotService = new ScreenshotService()

export function trayIconPath(): string {
  return join(app.getAppPath(), 'assets', process.platform === 'win32' ? 'tray.ico' : 'tray.png')
}
