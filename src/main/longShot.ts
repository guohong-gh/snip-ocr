import { app, BrowserWindow, clipboard, dialog, nativeImage, screen, type Display, type WebContents } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ocrService } from './ocr'
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
import type { Bounds } from 'electron-screenshots'
import type { CaptureOutcome } from './screenshot'

/** 滚动跟随的采样间隔（含抓帧耗时） */
export const LONG_TICK_MS = 200
/** 画面静止连续多少个采样才采入一段 */
export const LONG_STABLE_TICKS = 2
/** 已滚动后，连续多少个采样仍与末帧相同即判定到底 */
export const LONG_BOTTOM_TICKS = 5
/** 收起遮罩后等页面重排完成再抓第一帧 */
export const LONG_WARMUP_MS = 220

/** 页面裁剪时的外扩像素，避免浮点坐标把边缘切掉 */
const FRAME_CROP_PAD = 2

/**
 * 计算「整屏原图 → 遮罩页裁剪」所需的源图矩形。
 * 长图取帧与自检的同源比对共用同一份坐标口径，避免两条管线各算一套。
 */
export function planLongFrameCrop(
  bounds: Bounds,
  imageWidth: number,
  imageHeight: number,
  scaleX: number,
  scaleY: number,
): { x: number; y: number; width: number; height: number; crop: Bounds } {
  const left = bounds.x * scaleX
  const top = bounds.y * scaleY
  const right = (bounds.x + bounds.width) * scaleX
  const bottom = (bounds.y + bounds.height) * scaleY
  const x = Math.max(0, Math.floor(left) - FRAME_CROP_PAD)
  const y = Math.max(0, Math.floor(top) - FRAME_CROP_PAD)
  const width = Math.max(1, Math.min(imageWidth, Math.ceil(right) + FRAME_CROP_PAD) - x)
  const height = Math.max(1, Math.min(imageHeight, Math.ceil(bottom) + FRAME_CROP_PAD) - y)
  return {
    x,
    y,
    width,
    height,
    crop: {
      x: x / scaleX,
      y: y / scaleY,
      width: width / scaleX,
      height: height / scaleY,
    },
  }
}

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

export interface OcrResultPayload {
  requestId: number
  status: 'ready' | 'empty' | 'error'
  text: string
  language: string
  error: string | null
}

/** 长图模块向截图服务借用的能力，避免反向持有整个 ScreenshotService */
export interface LongShotDeps {
  view(): WebContents | null
  overlayWindow(): BrowserWindow | null
  notify(title: string, body: string): void
  emitOutcome(outcome: CaptureOutcome): void
  emptySize(): Pick<
    CaptureOutcome,
    'width' | 'height' | 'selectionWidth' | 'selectionHeight' | 'selectionX' | 'selectionY'
  >
  endCapture(): Promise<void>
  emitCaptureEnded(): void
  isDisposed(): boolean
  setCapturing(capturing: boolean): void
  sendOcrResult(contents: WebContents, payload: OcrResultPayload): void
  tryStartOcr(): boolean
  endOcr(): void
}

export class LongShotController {
  private session: LongShotSession | null = null
  private result: LongShotResult | null = null
  private token = 0
  private hudWatch: NodeJS.Timeout | null = null
  private hudDisplay: Display | null = null
  private hudRects: { hud: HudRect | null; sidebar: HudRect | null } = { hud: null, sidebar: null }
  private hudHover = false
  private saveBusy = false

  constructor(private readonly deps: LongShotDeps) {}

  isActive(): boolean {
    return this.session !== null
  }

  hasResult(): boolean {
    return this.result !== null
  }

  /**
   * 长图入口：记录选区 → 收起主遮罩只留细边框与 HUD → 后台静默跟随滚动。
   * 用户全程不按键；滚到底静止后自动拼接、复制，并给出另存 / OCR 入口。
   */
  async handleAction(contents: WebContents): Promise<void> {
    if (this.session) {
      await this.finish('manual')
      return
    }
    if (this.result) return
    const bounds = await this.readOverlaySelection(contents)
    if (!bounds) return
    await this.startPassiveLongShot(contents, bounds)
  }

  /** 结束跟随：拼接 → 复制 → HUD 切到完成态（另存 / OCR 入口） */
  async finish(reason: 'bottom' | 'manual'): Promise<void> {
    const session = this.session
    if (!session || this.result) return
    session.token = -1
    this.session = null
    this.token += 1
    let stitched: StitchResult
    try {
      stitched = stitchVertical(session.frames)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[snip] long screenshot stitch failed:', error)
      this.deps.notify('长截图拼接失败', message)
      await this.close(true)
      return
    }
    console.info('[snip] long screenshot finished:', reason, session.frames.length, 'frames')
    const bounds: Bounds = {
      x: session.bounds.x,
      y: session.bounds.y,
      width: session.bounds.width,
      height: stitched.height / (session.display.scaleFactor || 1),
    }
    this.result = { stitched, bounds, display: session.display }
    void recordPinHistory(stitched.buffer, stitched.width, stitched.height, 'longshot')
    this.copy()
    const win = this.deps.overlayWindow()
    win?.setFocusable(true)
    await this.pushState({
      phase: 'done',
      width: stitched.width,
      height: stitched.height,
      segments: stitched.segments.length,
    })
    if (stitched.segments.length > 1) {
      this.deps.notify('长截图已分段', `共 ${stitched.segments.length} 段，首段已复制，其余请用「另存」导出`)
    }
  }

  copy(): void {
    const result = this.result
    if (!result) return
    clipboard.writeImage(nativeImage.createFromBuffer(result.stitched.buffer))
    this.deps.emitOutcome({
      kind: 'copied',
      width: result.stitched.width,
      height: result.stitched.height,
      selectionWidth: Math.round(result.bounds.width),
      selectionHeight: Math.round(result.bounds.height),
      selectionX: Math.round(result.bounds.x),
      selectionY: Math.round(result.bounds.y),
    })
  }

  async save(): Promise<void> {
    const result = this.result
    const win = this.deps.overlayWindow()
    if (!result || !win || this.saveBusy) return
    this.saveBusy = true
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
      this.deps.notify(
        '长截图已保存',
        segments.length > 1 ? `${paths[0]} 等 ${segments.length} 个文件` : paths[0],
      )
    } catch (error) {
      console.error('[snip] long screenshot save failed:', error)
      this.deps.notify('长截图保存失败', error instanceof Error ? error.message : String(error))
    } finally {
      this.saveBusy = false
    }
  }

  async runOcr(contents: WebContents, requestId: number): Promise<void> {
    const result = this.result
    if (!result || !this.deps.tryStartOcr()) return
    try {
      const ocr = await ocrService.recognizeLongImage(result.stitched.segments.map((segment) => segment.buffer))
      if (!ocr.text) {
        this.deps.sendOcrResult(contents, { requestId, status: 'empty', text: '', language: '', error: '未识别到文字' })
        return
      }
      this.deps.sendOcrResult(contents, { requestId, status: 'ready', text: ocr.text, language: ocr.language, error: null })
    } catch (error) {
      this.deps.sendOcrResult(contents, {
        requestId,
        status: 'error',
        text: '',
        language: '',
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      this.deps.endOcr()
    }
  }

  /** 结束长图态：恢复遮罩窗口属性，收回 HUD；emitCancel 用于取消路径 */
  async close(emitCancel = false): Promise<void> {
    const hadSession = this.session !== null || this.result !== null
    // 长图期间遮罩只是暂隐/透明，hide 不会触发；显式结束会话，避免 stopCapture 重复广播
    this.deps.setCapturing(false)
    this.session = null
    this.result = null
    this.token += 1
    this.stopHudWatch()
    this.hudDisplay = null
    this.hudRects = { hud: null, sidebar: null }
    const win = this.deps.overlayWindow()
    if (win) {
      win.setContentProtection(false)
      win.setFocusable(true)
      win.setIgnoreMouseEvents(false)
    }
    const contents = this.deps.view()
    if (contents && !contents.isDestroyed()) {
      await contents.executeJavaScript('window.__snipLongEnd?.()').catch(() => undefined)
    }
    if (emitCancel && hadSession) {
      this.deps.emitOutcome({ kind: 'cancelled', ...this.deps.emptySize() })
    }
    await this.deps.endCapture()
    // 长图期间遮罩是暂隐状态，finalizeCapture 不会广播结束；真正关闭时在此补发，恢复主窗
    if (hadSession && !this.deps.isDisposed()) this.deps.emitCaptureEnded()
  }

  updateHudRects(raw: string): void {
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

  private async startPassiveLongShot(contents: WebContents, bounds: Bounds): Promise<void> {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const token = (this.token += 1)
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
    this.session = session
    this.result = null
    await this.enterLongHud(contents, display, bounds)
    await sleep(LONG_WARMUP_MS)
    const tick = await this.grabTick(display, bounds)
    if (!tick) {
      this.deps.notify('长截图无法开始', '未能获取屏幕画面')
      await this.close(true)
      return
    }
    // 笔迹只在首帧叠加一次：拼接结果顶部保留标注，后续滚动帧保持干净
    const first = await this.extractFrame(contents, bounds, tick, true)
    if (!first) {
      this.deps.notify('长截图无法开始', '未能获取屏幕画面')
      await this.close(true)
      return
    }
    if (this.session !== session) return
    session.frames.push(first.png)
    session.fingerprints.push(tick.fingerprint)
    session.signatures.push(first.signature)
    session.height = first.signature.height
    await contents.executeJavaScript('window.__snipLongAppend?.(0)').catch(() => undefined)
    await this.pushState({ phase: 'follow', count: 1, height: session.height })
    void this.followLoop(token)
  }

  /** 收起主遮罩：只留一圈细边框和 HUD，窗口鼠标穿透且不抢焦点 */
  private async enterLongHud(contents: WebContents, display: Display, bounds: Bounds): Promise<void> {
    this.hudDisplay = display
    this.hudRects = { hud: null, sidebar: null }
    const win = this.deps.overlayWindow()
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
    const session = this.session
    if (!session) return
    let previousTick: FrameFingerprint | null = null
    let sameTicks = 0
    while (this.session === session && session.token === token) {
      const started = Date.now()
      const tick = await this.grabTick(session.display, session.bounds)
      if (this.session !== session || session.token !== token) return
      if (tick) {
        sameTicks = previousTick && framesLookSame(tick.fingerprint, previousTick) ? sameTicks + 1 : 0
        previousTick = tick.fingerprint
        if (sameTicks >= LONG_STABLE_TICKS) {
          const lastAccepted = session.fingerprints[session.fingerprints.length - 1]
          if (!framesLookSame(tick.fingerprint, lastAccepted)) {
            const contents = this.deps.view()
            const frame = contents && !contents.isDestroyed()
              ? await this.extractFrame(contents, session.bounds, tick)
              : null
            if (this.session !== session || session.token !== token) return
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
              await this.pushState({
                phase: 'follow',
                count: session.frames.length,
                height: session.height,
              })
            }
          } else if (session.scrolled && sameTicks >= LONG_BOTTOM_TICKS) {
            await this.finish('bottom')
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
    annotate = false,
  ): Promise<{ png: Buffer; signature: RowSignatures } | null> {
    try {
      const image = tick.image
      const plan = planLongFrameCrop(bounds, image.width, image.height, tick.scaleX, tick.scaleY)
      const crop = image.cropSync(plan.x, plan.y, plan.width, plan.height)
      const dataUrl = `data:image/png;base64,${crop.toPngSync().toString('base64')}`
      const payload = {
        dataUrl,
        crop: plan.crop,
        bounds,
      }
      const result = (await contents.executeJavaScript(
        `window.__snipLongFrame?.(${JSON.stringify(payload)}, ${annotate ? 'true' : 'false'})`,
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

  private async pushState(state: Record<string, unknown>): Promise<void> {
    const contents = this.deps.view()
    if (!contents || contents.isDestroyed()) return
    await contents.executeJavaScript(`window.__snipLongState?.(${JSON.stringify(state)})`).catch(() => undefined)
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
