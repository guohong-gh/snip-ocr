import {
  app,
  clipboard,
  dialog,
  globalShortcut,
  nativeImage,
  Notification,
  screen,
  type BrowserWindow,
  type Display,
  type WebContents,
} from 'electron'
import Screenshots, { type Bounds } from 'electron-screenshots'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_HOTKEY, type IconTheme } from '@shared/ipc'
import { ocrService } from './ocr'
import {
  captureOverlaySelection,
  hideOverlaySidebar,
  installOverlayUi,
  OVERLAY_ACTION_PREFIX,
  OVERLAY_COPY_PREFIX,
  OVERLAY_HUD_RECT_PREFIX,
  updateOverlayTheme,
} from './overlayUi'
import { pinService, type PinCaptureInput } from './pin'
import { recordPinHistory } from './pinHistory'
import {
  buildRowSignatures,
  detectStickyRows,
  fingerprintPixels,
  framesLookSame,
  matchOverlap,
  stitchVertical,
  type FrameFingerprint,
  type RowSignatures,
  type StitchResult,
} from './stitch'

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

/** 滚动跟随的采样间隔（含抓帧耗时） */
const LONG_TICK_MS = 200
/** 画面静止连续多少个采样才采入一段 */
const LONG_STABLE_TICKS = 2
/** 采入最后一段后，静止多久判定到底（采样次数） */
const LONG_BOTTOM_TICKS = 5
/** 进入 HUD 后等一帧再抓首帧，避免抓到遮罩切换瞬间 */
const LONG_WARMUP_MS = 220

/** 长截图会话：固定选区 + 已采集的帧（按采集顺序） */
interface LongShotSession {
  /** 选区 DIP，相对显示器原点；所有帧都按这个矩形裁切 */
  bounds: Bounds
  display: Display
  frames: Buffer[]
  /** 与 frames 一一对应的低分辨率指纹 */
  fingerprints: FrameFingerprint[]
  /** 与 frames 一一对应的整行指纹，用于增量重叠与实时预览 */
  signatures: RowSignatures[]
  /** 已拼接高度（物理像素），与预览画布一致 */
  height: number
  /** 是否已采入过滚动后的新内容 */
  scrolled: boolean
  /** 会话令牌，换会话后旧循环自动退出 */
  token: number
}

/** 完成后的长截图结果，供 HUD 上的复制 / 另存 / OCR 使用 */
interface LongShotResult {
  stitched: StitchResult
  bounds: Bounds
  display: Display
}

interface HudRect {
  x: number
  y: number
  width: number
  height: number
}

type NodeScreenshots = typeof import('node-screenshots')
type NativeImage = Awaited<ReturnType<InstanceType<NodeScreenshots['Monitor']>['captureImage']>>

let screenshotsModule: Promise<NodeScreenshots> | null = null

/**
 * node-screenshots 是 electron-screenshots 的既有依赖，electron.vite.config.ts 已把它列为 external。
 * 这里只借用它做「不含遮罩的静默抓帧」。
 */
function loadNodeScreenshots(): Promise<NodeScreenshots> {
  if (!screenshotsModule) screenshotsModule = import('node-screenshots')
  return screenshotsModule
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
  private longShotResult: LongShotResult | null = null
  private longShotToken = 0
  private hudWatch: NodeJS.Timeout | null = null
  private hudDisplay: Display | null = null
  private hudRects: { hud: HudRect | null; sidebar: HudRect | null } = { hud: null, sidebar: null }
  private hudHover = false
  private longSaveBusy = false

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
      if (this.longShot || this.longShotResult) {
        // 长图态下遮罩里没有可裁的选区，改用拼接结果走自己的保存流程
        event.preventDefault()
        void this.saveLongShot()
        return
      }
      // 不 preventDefault：库的默认行为会弹出系统保存对话框并写 PNG，收尾由窗口 hide 触发
      this.lastCapture = { buffer, bounds: data.bounds, display: data.display }
      const size = this.sizeOf(buffer, data)
      void recordPinHistory(buffer, size.width, size.height, 'save')
      this.emit({ kind: 'saved', ...size })
    })
    lib.on('cancel', () => {
      const wasCapturing = this.capturing
      if (this.longShot || this.longShotResult) {
        void this.closeLongShot(true)
        return
      }
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
    if (message.startsWith(OVERLAY_HUD_RECT_PREFIX)) {
      this.updateHudRects(message.slice(OVERLAY_HUD_RECT_PREFIX.length))
      return
    }
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
    switch (action?.action) {
      case 'longshot':
        void this.handleLongShotAction(contents)
        return
      case 'longshot-finish':
        void this.finishLongShot('manual')
        return
      case 'longshot-copy':
        this.copyLongShot()
        return
      case 'longshot-save':
        void this.saveLongShot()
        return
      case 'longshot-ocr':
        void this.runLongShotOcr(contents, action.requestId ?? Date.now())
        return
      case 'longshot-close':
        void this.closeLongShot()
        return
      case 'longshot-cancel':
        void this.closeLongShot(true)
        return
      case 'ocr':
        void this.runOcr(contents, action.requestId ?? Date.now())
        return
      default:
        return
    }
  }

  private updateHudRects(raw: string): void {
    try {
      const parsed = JSON.parse(raw) as { hud?: HudRect | null; sidebar?: HudRect | null }
      this.hudRects = {
        hud: parsed.hud ?? null,
        sidebar: parsed.sidebar ?? null,
      }
    } catch {
      this.hudRects = { hud: null, sidebar: null }
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
    if (this.longShot || this.longShotResult) {
      // 长图态 Esc = 取消：不写剪贴板，下次从头开始
      await this.closeLongShot(true)
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
    const finalBuffer = buffer
    const finalData = data
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
    if (this.longShot) {
      // 长图跟随中再按热键 = 立刻结束并复制当前结果
      await this.finishLongShot('manual')
      return
    }
    if (this.longShotResult) return
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

  /**
   * 长图入口：记录选区 → 收起主遮罩只留细边框与 HUD → 后台静默跟随滚动。
   * 用户全程不按键；滚到底静止后自动拼接、复制，并给出另存 / OCR 入口。
   */
  private async handleLongShotAction(contents: WebContents): Promise<void> {
    if (this.longShot) {
      await this.finishLongShot('manual')
      return
    }
    if (this.longShotResult) return
    const bounds = await this.readOverlaySelection(contents)
    if (!bounds) return
    await this.startPassiveLongShot(contents, bounds)
  }

  private async startPassiveLongShot(contents: WebContents, bounds: Bounds): Promise<void> {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const token = (this.longShotToken += 1)
    const session: LongShotSession = {
      bounds,
      display,
      frames: [],
      fingerprints: [],
      signatures: [],
      height: 0,
      scrolled: false,
      token,
    }
    this.longShot = session
    this.longShotResult = null
    await this.enterLongHud(contents, display, bounds)
    await sleep(LONG_WARMUP_MS)
    const tick = await this.grabTick(display, bounds)
    if (!tick) {
      this.notify('长截图无法开始', '未能获取屏幕画面')
      await this.closeLongShot(true)
      return
    }
    const first = await this.extractFrame(contents, bounds, tick)
    if (!first) {
      this.notify('长截图无法开始', '未能获取屏幕画面')
      await this.closeLongShot(true)
      return
    }
    if (this.longShot !== session) return
    session.frames.push(first.png)
    session.fingerprints.push(tick.fingerprint)
    session.signatures.push(first.signature)
    session.height = first.signature.height
    await contents.executeJavaScript('window.__snipLongAppend?.(0)').catch(() => undefined)
    await this.pushLongHudState({ phase: 'follow', count: 1, height: session.height })
    void this.followLoop(token)
  }

  /** 收起主遮罩：只留一圈细边框和 HUD，窗口鼠标穿透且不抢焦点 */
  private async enterLongHud(contents: WebContents, display: Display, bounds: Bounds): Promise<void> {
    this.hudDisplay = display
    this.hudRects = { hud: null, sidebar: null }
    const win = this.overlayWindow()
    if (win) {
      // 双保险：HUD 画在选区外，遮罩本身也用内容保护排除在抓帧之外
      win.setContentProtection(true)
      win.blur()
      win.setFocusable(false)
      win.setIgnoreMouseEvents(true, { forward: true })
      this.startHudWatch(win)
    }
    await contents
      .executeJavaScript(`window.__snipLongStart?.(${JSON.stringify(bounds)})`)
      .catch(() => undefined)
  }

  /** 后台静默跟随：静止且内容有变化才入栈；静止且与末帧相同即判定到底 */
  private async followLoop(token: number): Promise<void> {
    const session = this.longShot
    if (!session) return
    let previousTick: FrameFingerprint | null = null
    let sameTicks = 0
    while (this.longShot === session && session.token === token) {
      const started = Date.now()
      const tick = await this.grabTick(session.display, session.bounds)
      if (this.longShot !== session || session.token !== token) return
      if (tick) {
        sameTicks = previousTick && framesLookSame(tick.fingerprint, previousTick) ? sameTicks + 1 : 0
        previousTick = tick.fingerprint
        if (sameTicks >= LONG_STABLE_TICKS) {
          const lastAccepted = session.fingerprints[session.fingerprints.length - 1]
          if (!framesLookSame(tick.fingerprint, lastAccepted)) {
            const contents = this.view
            const frame = contents && !contents.isDestroyed()
              ? await this.extractFrame(contents, session.bounds, tick)
              : null
            if (this.longShot !== session || session.token !== token) return
            if (frame) {
              const previousSignature = session.signatures[session.signatures.length - 1]
              const nextTop = detectStickyRows(session.signatures[0], frame.signature)
              const overlap = matchOverlap(previousSignature, frame.signature, nextTop)
              const startRow = Math.min(frame.signature.height, nextTop + overlap)
              session.frames.push(frame.png)
              session.fingerprints.push(tick.fingerprint)
              session.signatures.push(frame.signature)
              session.height += frame.signature.height - startRow
              session.scrolled = true
              sameTicks = 0
              await contents
                ?.executeJavaScript(`window.__snipLongAppend?.(${startRow})`)
                .catch(() => undefined)
              await this.pushLongHudState({
                phase: 'follow',
                count: session.frames.length,
                height: session.height,
              })
            }
          } else if (session.scrolled && sameTicks >= LONG_BOTTOM_TICKS) {
            await this.finishLongShot('bottom')
            return
          }
        }
      }
      await sleep(Math.max(60, LONG_TICK_MS - (Date.now() - started)))
    }
  }

  /** 抓一帧原生画面：低分辨率指纹用于运动检测，整数裁剪 PNG 作为页面裁剪失败时的回退 */
  private async grabTick(
    display: Display,
    bounds: Bounds,
  ): Promise<{ image: NativeImage; scaleX: number; scaleY: number; png: Buffer; fingerprint: FrameFingerprint } | null> {
    try {
      const { Monitor } = await loadNodeScreenshots()
      const monitor = Monitor.fromPoint(
        display.bounds.x + display.size.width / 2,
        display.bounds.y + display.size.height / 2,
      )
      if (!monitor) return null
      const image = await monitor.captureImage()
      if (image.width < 1 || image.height < 1) return null
      const scaleX = image.width / display.size.width
      const scaleY = image.height / display.size.height
      const x = Math.max(0, Math.min(image.width - 1, Math.round(bounds.x * scaleX)))
      const y = Math.max(0, Math.min(image.height - 1, Math.round(bounds.y * scaleY)))
      const width = Math.max(1, Math.min(image.width - x, Math.round(bounds.width * scaleX)))
      const height = Math.max(1, Math.min(image.height - y, Math.round(bounds.height * scaleY)))
      const cropped = image.cropSync(x, y, width, height)
      return {
        image,
        scaleX,
        scaleY,
        png: cropped.toPngSync(),
        fingerprint: fingerprintPixels(cropped.toRawSync(), cropped.width, cropped.height),
      }
    } catch (error) {
      console.error('[snip] long screenshot capture failed:', error)
      return null
    }
  }

  /**
   * 入栈帧走与普通截图完全相同的 canvas 裁剪（同一 DPR、同一小数源坐标与插值），
   * 只把选区周围的一小块 PNG 交给遮罩页，避免每帧传输整屏。
   */
  private async extractFrame(
    contents: WebContents,
    bounds: Bounds,
    tick: { image: NativeImage; scaleX: number; scaleY: number; png: Buffer },
  ): Promise<{ png: Buffer; signature: RowSignatures } | null> {
    try {
      const image = tick.image
      const left = bounds.x * tick.scaleX
      const top = bounds.y * tick.scaleY
      const right = (bounds.x + bounds.width) * tick.scaleX
      const bottom = (bounds.y + bounds.height) * tick.scaleY
      const pad = 2
      const x0 = Math.max(0, Math.floor(left) - pad)
      const y0 = Math.max(0, Math.floor(top) - pad)
      const x1 = Math.min(image.width, Math.ceil(right) + pad)
      const y1 = Math.min(image.height, Math.ceil(bottom) + pad)
      const crop = image.cropSync(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0))
      const dataUrl = `data:image/png;base64,${crop.toPngSync().toString('base64')}`
      const payload = {
        dataUrl,
        crop: {
          x: x0 / tick.scaleX,
          y: y0 / tick.scaleY,
          width: crop.width / tick.scaleX,
          height: crop.height / tick.scaleY,
        },
        bounds,
      }
      const result = (await contents.executeJavaScript(
        `window.__snipLongFrame?.(${JSON.stringify(payload)})`,
      )) as unknown
      if (typeof result === 'string' && result.startsWith('data:image/png;base64,')) {
        const png = Buffer.from(result.slice('data:image/png;base64,'.length), 'base64')
        const decoded = nativeImage.createFromBuffer(png)
        const size = decoded.getSize()
        if (size.width >= 1 && size.height >= 1) {
          return { png, signature: buildRowSignatures(decoded.toBitmap(), size.width, size.height) }
        }
      }
    } catch (error) {
      console.error('[snip] long screenshot page crop failed:', error)
    }
    // 页面不可用时回退到原生整数裁剪，保证采集不中断
    const fallback = nativeImage.createFromBuffer(tick.png)
    const size = fallback.getSize()
    if (size.width < 1 || size.height < 1) return null
    return { png: tick.png, signature: buildRowSignatures(fallback.toBitmap(), size.width, size.height) }
  }

  /** 只有鼠标移进 HUD / 侧栏时才让窗口接收事件，其余时间保持穿透 */
  private startHudWatch(win: BrowserWindow): void {
    this.stopHudWatch()
    this.hudWatch = setInterval(() => {
      const display = this.hudDisplay
      if (!display) return
      const point = screen.getCursorScreenPoint()
      const inside = [this.hudRects.hud, this.hudRects.sidebar].some((rect) => {
        if (!rect) return false
        return (
          point.x >= display.bounds.x + rect.x &&
          point.x < display.bounds.x + rect.x + rect.width &&
          point.y >= display.bounds.y + rect.y &&
          point.y < display.bounds.y + rect.y + rect.height
        )
      })
      if (inside === this.hudHover) return
      this.hudHover = inside
      win.setIgnoreMouseEvents(!inside, { forward: true })
    }, 100)
  }

  private stopHudWatch(): void {
    if (this.hudWatch) {
      clearInterval(this.hudWatch)
      this.hudWatch = null
    }
    this.hudHover = false
  }

  private overlayWindow(): BrowserWindow | null {
    return (this.lib as (Screenshots & { $win?: BrowserWindow }) | null)?.$win ?? null
  }

  private async pushLongHudState(state: Record<string, unknown>): Promise<void> {
    const contents = this.view
    if (!contents || contents.isDestroyed()) return
    await contents.executeJavaScript(`window.__snipLongState?.(${JSON.stringify(state)})`).catch(() => undefined)
  }

  /** 结束跟随：拼接 → 复制 → HUD 切到完成态（另存 / OCR 入口） */
  private async finishLongShot(reason: 'bottom' | 'manual'): Promise<void> {
    const session = this.longShot
    if (!session || this.longShotResult) return
    session.token = -1
    this.longShot = null
    this.longShotToken += 1
    let stitched: StitchResult
    try {
      stitched = stitchVertical(session.frames)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[snip] long screenshot stitch failed:', error)
      this.notify('长截图拼接失败', message)
      await this.closeLongShot(true)
      return
    }
    console.info('[snip] long screenshot finished:', reason, session.frames.length, 'frames')
    const bounds: Bounds = {
      x: session.bounds.x,
      y: session.bounds.y,
      width: session.bounds.width,
      height: stitched.height / (session.display.scaleFactor || 1),
    }
    this.longShotResult = { stitched, bounds, display: session.display }
    void recordPinHistory(stitched.buffer, stitched.width, stitched.height, 'longshot')
    this.copyLongShot()
    const win = this.overlayWindow()
    win?.setFocusable(true)
    await this.pushLongHudState({
      phase: 'done',
      width: stitched.width,
      height: stitched.height,
      segments: stitched.segments.length,
    })
    if (stitched.segments.length > 1) {
      this.notify('长截图已分段', `共 ${stitched.segments.length} 段，首段已复制，其余请用「另存」导出`)
    }
  }

  private copyLongShot(): void {
    const result = this.longShotResult
    if (!result) return
    this.lastCapture = {
      buffer: result.stitched.buffer,
      bounds: result.bounds,
      display: {
        x: result.display.bounds.x,
        y: result.display.bounds.y,
        width: result.display.bounds.width,
        height: result.display.bounds.height,
        scaleFactor: result.display.scaleFactor,
      },
    }
    clipboard.writeImage(nativeImage.createFromBuffer(result.stitched.buffer))
    this.emit({
      kind: 'copied',
      width: result.stitched.width,
      height: result.stitched.height,
      selectionWidth: Math.round(result.bounds.width),
      selectionHeight: Math.round(result.bounds.height),
      selectionX: Math.round(result.bounds.x),
      selectionY: Math.round(result.bounds.y),
    })
  }

  private async saveLongShot(): Promise<void> {
    const result = this.longShotResult
    const win = this.overlayWindow()
    if (!result || !win || this.longSaveBusy) return
    this.longSaveBusy = true
    try {
      const segments = result.stitched.segments
      const picked = await dialog.showSaveDialog(win, {
        title: '保存长截图',
        defaultPath: join(app.getPath('pictures'), `snip-${fileStamp()}.png`),
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
      })
      const filePath = picked.filePath
      if (picked.canceled || !filePath) return
      const paths = segments.length === 1
        ? [filePath]
        : segments.map((_, index) => segmentPath(filePath, index + 1))
      for (let index = 0; index < segments.length; index += 1) {
        await writeFile(paths[index], segments[index].buffer)
      }
      this.notify(
        '长截图已保存',
        segments.length > 1 ? `${paths[0]} 等 ${segments.length} 个文件` : paths[0],
      )
    } catch (error) {
      console.error('[snip] long screenshot save failed:', error)
      this.notify('长截图保存失败', error instanceof Error ? error.message : String(error))
    } finally {
      this.longSaveBusy = false
    }
  }

  private async runLongShotOcr(contents: WebContents, requestId: number): Promise<void> {
    const result = this.longShotResult
    if (!result || this.ocrRunning) return
    this.ocrRunning = true
    try {
      const ocr = await ocrService.recognize(result.stitched.buffer)
      if (!ocr.text) {
        this.sendOcrResult(contents, { requestId, status: 'empty', text: '', language: '', error: '未识别到文字' })
        return
      }
      this.sendOcrResult(contents, { requestId, status: 'ready', text: ocr.text, language: ocr.language, error: null })
    } catch (error) {
      this.sendOcrResult(contents, {
        requestId,
        status: 'error',
        text: '',
        language: '',
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.ocrRunning = false
    }
  }

  /** 结束长图态：恢复遮罩窗口属性，收回 HUD；emitCancel 用于取消路径 */
  private async closeLongShot(emitCancel = false): Promise<void> {
    const hadSession = this.longShot !== null || this.longShotResult !== null
    // 长图期间遮罩只是暂隐/透明，hide 不会触发；显式结束会话，避免 stopCapture 重复广播
    this.capturing = false
    this.longShot = null
    this.longShotResult = null
    this.longShotToken += 1
    this.stopHudWatch()
    this.hudDisplay = null
    this.hudRects = { hud: null, sidebar: null }
    const win = this.overlayWindow()
    if (win) {
      win.setContentProtection(false)
      win.setFocusable(true)
      win.setIgnoreMouseEvents(false)
    }
    const contents = this.view
    if (contents && !contents.isDestroyed()) {
      await contents.executeJavaScript('window.__snipLongEnd?.()').catch(() => undefined)
    }
    if (emitCancel && hadSession) this.emit({ kind: 'cancelled', ...this.emptySize() })
    await this.stopCapture()
    // 长图期间遮罩是暂隐状态，finalizeCapture 不会广播结束；真正关闭时在此补发，恢复主窗
    if (hadSession && !this.disposed) this.emitCaptureEnded()
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

function fileStamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** 分段保存时在扩展名前追加 -1/-2… 后缀 */
function segmentPath(filePath: string, index: number): string {
  return filePath.replace(/(\.[^.\\/]+)$/, `-${index}$1`)
}

export const screenshotService = new ScreenshotService()

export function trayIconPath(): string {
  return join(app.getAppPath(), 'assets', process.platform === 'win32' ? 'tray.ico' : 'tray.png')
}
