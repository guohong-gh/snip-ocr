import { BrowserWindow, app, clipboard, dialog, nativeImage, net, protocol, screen } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  PIN_RESIZE_DIRECTIONS,
  type PinMeta,
  type PinResizeDirection,
  type PinSummary,
  type SetHotkeyResult,
} from '@shared/ipc'
import { recordPinHistory, type PinHistoryImage } from './pinHistory'
import { removeFileEventually } from './tempFiles'

const PIN_TITLE = 'snip-pin'
/** 贴图图片走自定义协议，避免 dev 模式下 http 页面无法加载 file:// 本地资源 */
const PIN_SCHEME = 'snip-pin'
const PIN_HOST = 'image'
const MIN_PIN_SIZE = 24
/** 列表缩略图最长边（像素），与截图历史缩略图保持同一档 */
const THUMB_MAX_SIDE = 192
const READY_TIMEOUT_MS = 5000
const READY_TIMEOUT_DEV_MS = 8000

let schemeRegistered = false

/** 必须在 app ready 之前调用 */
export function registerPinScheme(): void {
  if (schemeRegistered) return
  schemeRegistered = true
  protocol.registerSchemesAsPrivileged([
    { scheme: PIN_SCHEME, privileges: { standard: true, secure: true } },
  ])
}

let protocolReady: Promise<void> | null = null

export function ensurePinProtocol(): Promise<void> {
  protocolReady ??= (async () => {
    await protocol.handle(PIN_SCHEME, async (request) => {
      try {
        const file = resolvePinImagePath(request.url)
        if (!file) return new Response(null, { status: 404 })
        return await net.fetch(pathToFileURL(file).href)
      } catch (error) {
        pinDebug('protocol error', error)
        return new Response(null, { status: 404 })
      }
    })
  })()
  return protocolReady
}

export function pinImageUrl(filePath: string): string {
  return `${PIN_SCHEME}://${PIN_HOST}/${encodeURIComponent(basename(filePath))}`
}

export function resolvePinImagePath(rawUrl: string): string | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${PIN_SCHEME}:` || url.hostname !== PIN_HOST) return null
  let name: string
  try {
    name = decodeURIComponent(url.pathname.replace(/^\//, ''))
  } catch {
    return null
  }
  if (!name || name !== basename(name) || !isPinTempFile(name) || name.includes('..')) return null
  const dir = resolve(pinTempDir())
  const full = resolve(join(dir, name))
  return dirname(full) === dir ? full : null
}

export interface PinCaptureBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface PinCaptureDisplay extends PinCaptureBounds {
  scaleFactor: number
}

export interface PinCaptureInput {
  buffer: Buffer
  bounds: PinCaptureBounds
  display: PinCaptureDisplay
}

export interface CreatePinOptions {
  /** 从截图历史重新贴出时传 false，避免同一条历史被反复记录 */
  recordHistory?: boolean
}

export interface PinPlacementInput {
  imageWidth: number
  imageHeight: number
  selection: { x: number; y: number }
  display: { x: number; y: number; scaleFactor: number }
}

export interface PinPlacement {
  x: number
  y: number
  width: number
  height: number
  scaleFactor: number
}

/**
 * 贴图窗口用 DIP 创建，内容区 DIP × scaleFactor 必须等于图片物理像素。
 * 位置取显示器 DIP 原点 + 选区 DIP 偏移，保证 125%/150% 下不缩小、不偏移。
 */
export function computePinPlacement(input: PinPlacementInput): PinPlacement {
  const raw = input.display.scaleFactor
  const scaleFactor = Number.isFinite(raw) && raw > 0 ? raw : 1
  return {
    x: Math.round(input.display.x + input.selection.x),
    y: Math.round(input.display.y + input.selection.y),
    width: Math.max(1, Math.round(input.imageWidth / scaleFactor)),
    height: Math.max(1, Math.round(input.imageHeight / scaleFactor)),
    scaleFactor,
  }
}

export interface PinHistoryPlacementInput {
  imageWidth: number
  imageHeight: number
  cursor: { x: number; y: number }
  display: { x: number; y: number; width: number; height: number; scaleFactor: number }
}

/**
 * 历史重贴落点：以当前光标为图片中心，并夹在光标所在显示器内。
 * 尺寸按 scaleFactor 换算成 DIP，与普通截图贴图一致。
 */
export function computeHistoryPinPlacement(input: PinHistoryPlacementInput): PinPlacement {
  const raw = input.display.scaleFactor
  const scaleFactor = Number.isFinite(raw) && raw > 0 ? raw : 1
  const width = input.imageWidth / scaleFactor
  const height = input.imageHeight / scaleFactor
  const clamp = (value: number, max: number): number => Math.max(0, Math.min(value, max))
  const selection = {
    x: clamp(input.cursor.x - input.display.x - width / 2, input.display.width - width),
    y: clamp(input.cursor.y - input.display.y - height / 2, input.display.height - height),
  }
  return computePinPlacement({
    imageWidth: input.imageWidth,
    imageHeight: input.imageHeight,
    selection,
    display: input.display,
  })
}

export function pinTempDir(): string {
  return join(app.getPath('userData'), 'pins')
}

const PIN_DEBUG = process.env['SNIP_PIN_DEBUG'] === '1'

function pinDebug(message: string, detail?: unknown): void {
  if (PIN_DEBUG) console.log(`[pin] ${message}`, detail ?? '')
}

/**
 * Windows 在创建透明无边框窗口时可能按物理像素取整多出 1-4 DIP（隐藏边框/菜单）。
 * 创建后立即用 setContentSize 纠正；次数受控，避免与窗口管理器来回拉扯。
 */
function applyPinGeometry(win: BrowserWindow, placement: PinPlacement): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const content = win.getContentBounds()
    if (content.width === placement.width && content.height === placement.height) break
    win.setContentSize(placement.width, placement.height, false)
  }
  pinDebug('geometry', {
    placement,
    bounds: win.getBounds(),
    content: win.getContentBounds(),
  })
}

interface PinInstance {
  id: number
  wcId: number
  win: BrowserWindow
  imagePath: string
  imageWidth: number
  imageHeight: number
  scaleFactor: number
  contentWidth: number
  contentHeight: number
  shown: boolean
  settled: boolean
  /** 用户从列表收起：窗口 hide 但实例与渲染状态（笔迹/缩放）保留 */
  hidden: boolean
  /** 收起前的置顶属性：Windows 上 hide/showInactive 后需要按原值重申 */
  alwaysOnTop: boolean
  /** 已合成笔迹的缩略图 PNG 与对应的 data URL，由贴图窗回传 */
  thumbBuffer: Buffer | null
  thumbUrl: string | null
  resolveReady: ((meta: PinMeta) => void) | null
  rejectReady: ((error: Error) => void) | null
  readyTimer: NodeJS.Timeout | null
  geometryTimer: NodeJS.Timeout | null
}

interface PointerGesture {
  kind: 'move' | 'resize'
  direction: PinResizeDirection | null
  startX: number
  startY: number
  startBounds: { x: number; y: number; width: number; height: number }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function toImageBuffer(data: unknown): Buffer | null {
  if (data instanceof Uint8Array) return Buffer.from(data)
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data))
  return null
}

function isResizeDirection(value: unknown): value is PinResizeDirection {
  return typeof value === 'string' && (PIN_RESIZE_DIRECTIONS as readonly string[]).includes(value)
}

function isPinTempFile(name: string): boolean {
  return name.startsWith('pin-') && name.endsWith('.png')
}

class PinService {
  private instances = new Map<number, PinInstance>()
  private gestures = new Map<number, PointerGesture>()
  private listeners = new Set<() => void>()
  private idSeq = 0
  private initPromise: Promise<void> | null = null

  get count(): number {
    return this.instances.size
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emitChange(): void {
    for (const listener of this.listeners) listener()
  }

  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit()
      // 显示器变化后把可能落到可见区外的贴图拉回来（诊断确认原先缺失）
      screen.on('display-metrics-changed', this.handleDisplaysChanged)
      screen.on('display-removed', this.handleDisplaysChanged)
    }
    return this.initPromise
  }

  private async doInit(): Promise<void> {
    try {
      await mkdir(pinTempDir(), { recursive: true })
      const files = await readdir(pinTempDir())
      await Promise.all(
        files.filter(isPinTempFile).map((file) => unlink(join(pinTempDir(), file)).catch(() => undefined)),
      )
    } catch (error) {
      console.error('[snip] pin temp init failed:', error)
    }
  }

  /** 历史重贴：落点以当前光标为图片中心，并夹在光标所在显示器内 */
  async pinFromHistory(image: PinHistoryImage): Promise<SetHotkeyResult> {
    const point = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(point)
    const displayBounds = { ...display.bounds, scaleFactor: display.scaleFactor }
    const placement = computeHistoryPinPlacement({
      imageWidth: image.width,
      imageHeight: image.height,
      cursor: point,
      display: displayBounds,
    })
    await this.createPin(
      {
        buffer: image.buffer,
        bounds: {
          x: placement.x - display.bounds.x,
          y: placement.y - display.bounds.y,
          width: placement.width,
          height: placement.height,
        },
        display: displayBounds,
      },
      { recordHistory: false },
    )
    return { ok: true }
  }

  async createPin(input: PinCaptureInput, options?: CreatePinOptions): Promise<PinMeta> {
    await this.init()
    await ensurePinProtocol()
    const image = nativeImage.createFromBuffer(input.buffer)
    const size = image.getSize()
    if (size.width <= 0 || size.height <= 0) throw new Error('贴图图片为空')

    const placement = computePinPlacement({
      imageWidth: size.width,
      imageHeight: size.height,
      selection: { x: input.bounds.x, y: input.bounds.y },
      display: input.display,
    })

    const id = this.idSeq + 1
    this.idSeq = id
    const imagePath = join(pinTempDir(), `pin-${Date.now()}-${randomUUID()}.png`)
    await writeFile(imagePath, input.buffer)

    let win: BrowserWindow
    try {
      win = new BrowserWindow({
        title: PIN_TITLE,
        x: placement.x,
        y: placement.y,
        width: placement.width,
        height: placement.height,
        minWidth: MIN_PIN_SIZE,
        minHeight: MIN_PIN_SIZE,
        useContentSize: true,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        hasShadow: false,
        autoHideMenuBar: true,
        // Windows 的 tool window 不会出现在 Alt+Tab / 任务栏
        ...(process.platform === 'win32' ? { type: 'toolbar' as const } : {}),
        webPreferences: {
          preload: join(__dirname, '../preload/index.js'),
          contextIsolation: true,
          nodeIntegration: false,
          spellcheck: false,
        },
      })
    } catch (error) {
      await removeFileEventually(imagePath)
      throw error
    }

    applyPinGeometry(win, placement)

    const wcId = win.webContents.id
    pinDebug('create', { id, wcId, imagePath, image: size, placement })
    const instance: PinInstance = {
      id,
      wcId,
      win,
      imagePath,
      imageWidth: size.width,
      imageHeight: size.height,
      scaleFactor: placement.scaleFactor,
      contentWidth: placement.width,
      contentHeight: placement.height,
      shown: false,
      settled: false,
      hidden: false,
      alwaysOnTop: true,
      thumbBuffer: null,
      thumbUrl: null,
      resolveReady: null,
      rejectReady: null,
      readyTimer: null,
      geometryTimer: null,
    }
    this.instances.set(wcId, instance)

    const ready = new Promise<PinMeta>((resolveMeta, rejectMeta) => {
      instance.resolveReady = resolveMeta
      instance.rejectReady = rejectMeta
    })

    win.on('page-title-updated', (event) => {
      event.preventDefault()
    })
    win.on('closed', () => {
      this.handleClosed(instance)
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('did-fail-load', (_event, code, description, url) => {
      pinDebug('did-fail-load', { code, description, url })
      if (code === -3) return // 页面加载被取消（窗口关闭）属正常
      this.failReady(instance, new Error(`贴图页加载失败：${description} (${code})`))
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      pinDebug('render-process-gone', details)
      this.failReady(instance, new Error(`贴图页渲染进程退出：${details.reason}`))
    })
    win.webContents.on('console-message', (_event, level, message) => {
      pinDebug('renderer-console', { level, message })
    })
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault()
        pinDebug('close via Esc', { wcId })
        this.closeFor(wcId)
      }
    })
    win.setAlwaysOnTop(true)

    const timeoutMs = process.env['ELECTRON_RENDERER_URL'] ? READY_TIMEOUT_DEV_MS : READY_TIMEOUT_MS
    instance.readyTimer = setTimeout(() => {
      this.failReady(instance, new Error('贴图窗口加载超时'))
    }, timeoutMs)

    const imageRef = pinImageUrl(imagePath)
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    const loading = devUrl
      ? win.loadURL(`${devUrl}/pin.html?image=${encodeURIComponent(imageRef)}`)
      : win.loadFile(join(__dirname, '../renderer/pin.html'), { query: { image: imageRef } })
    void loading.catch((error) => {
      // 窗口在加载完成前被关闭属于正常路径（Esc/关闭所有贴图）
      if (win.isDestroyed()) return
      console.error('[snip] pin page load failed:', error)
      this.failReady(instance, error instanceof Error ? error : new Error(String(error)))
    })

    this.emitChange()
    const meta = await ready
    if (options?.recordHistory !== false) {
      try {
        await recordPinHistory(input.buffer, size.width, size.height)
      } catch (error) {
        // 历史写入失败不影响贴图本身
        console.error('[snip] pin history record failed:', error)
      }
    }
    return meta
  }

  private metaOf(instance: PinInstance): PinMeta | null {
    if (instance.win.isDestroyed()) return null
    const content = instance.win.getContentBounds()
    return {
      id: instance.id,
      contentWidth: content.width,
      contentHeight: content.height,
      imageWidth: instance.imageWidth,
      imageHeight: instance.imageHeight,
      scaleFactor: instance.scaleFactor,
      alwaysOnTop: instance.win.isAlwaysOnTop(),
      resizable: instance.win.isResizable(),
    }
  }

  metaFor(senderId: number): PinMeta | null {
    const instance = this.instances.get(senderId)
    return instance ? this.metaOf(instance) : null
  }

  /** 贴图列表：新贴的排在前面；隐藏的实例仍在列表里 */
  list(): PinSummary[] {
    return [...this.instances.values()]
      .filter((instance) => !instance.win.isDestroyed())
      .sort((a, b) => b.id - a.id)
      .map((instance) => ({
        id: instance.id,
        thumbUrl: instance.thumbUrl,
        imageWidth: instance.imageWidth,
        imageHeight: instance.imageHeight,
        hidden: instance.hidden,
        alwaysOnTop: instance.hidden ? instance.alwaysOnTop : instance.win.isAlwaysOnTop(),
      }))
  }

  /** 贴图窗回传合成笔迹后的图，主进程负责缩放与缓存，列表直接取 data URL */
  setThumb(senderId: number, data: unknown): void {
    const instance = this.instances.get(senderId)
    if (!instance || instance.win.isDestroyed()) return
    const buffer = toImageBuffer(data)
    if (!buffer) return
    const image = nativeImage.createFromBuffer(buffer)
    if (image.isEmpty()) return
    const size = image.getSize()
    const ratio = Math.min(1, THUMB_MAX_SIDE / Math.max(size.width, size.height))
    const thumb =
      ratio >= 1
        ? image
        : image.resize({
            width: Math.max(1, Math.round(size.width * ratio)),
            height: Math.max(1, Math.round(size.height * ratio)),
            quality: 'good',
          })
    const png = thumb.toPNG()
    // 内容没变就不广播，节流之外的重复回传不会引起列表重绘
    if (instance.thumbBuffer && instance.thumbBuffer.equals(png)) return
    instance.thumbBuffer = png
    instance.thumbUrl = `data:image/png;base64,${png.toString('base64')}`
    this.emitChange()
  }

  /** 隐藏只收起窗口，不销毁，笔迹与缩放状态留在渲染进程 */
  setHidden(id: number, hidden: boolean): void {
    const instance = this.findByPublicId(id)
    if (!instance || instance.win.isDestroyed() || instance.hidden === hidden) return
    if (hidden) {
      // 收起前记录置顶属性：hide/showInactive 会丢失 topmost
      instance.alwaysOnTop = instance.win.isAlwaysOnTop()
      instance.win.hide()
    } else {
      this.clampToVisible(instance)
      instance.win.showInactive()
      instance.win.setAlwaysOnTop(instance.alwaysOnTop)
    }
    instance.hidden = hidden
    this.emitChange()
  }

  /** 一次性提到最前，不改变窗口原有的 alwaysOnTop 属性 */
  bringToFront(id: number): void {
    const instance = this.findByPublicId(id)
    if (!instance || instance.win.isDestroyed()) return
    this.clampToVisible(instance)
    if (!instance.win.isVisible()) {
      instance.win.showInactive()
      instance.win.setAlwaysOnTop(instance.alwaysOnTop)
      instance.hidden = false
    }
    instance.win.moveTop()
    this.emitChange()
  }

  private findByPublicId(id: number): PinInstance | null {
    for (const instance of this.instances.values()) {
      if (instance.id === id) return instance
    }
    return null
  }

  /** 把窗口夹回当前显示器工作区；返回是否发生了移动或缩放 */
  private clampToVisible(instance: PinInstance): boolean {
    if (instance.win.isDestroyed()) return false
    const bounds = instance.win.getBounds()
    const display = screen.getDisplayNearestPoint({
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2),
    })
    const area = display.workArea
    const width = Math.min(bounds.width, area.width)
    const height = Math.min(bounds.height, area.height)
    const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width)
    const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height)
    if (x === bounds.x && y === bounds.y && width === bounds.width && height === bounds.height) {
      return false
    }
    instance.win.setBounds({ x, y, width, height })
    instance.contentWidth = width
    instance.contentHeight = height
    return true
  }

  private handleDisplaysChanged = (): void => {
    let changed = false
    for (const instance of this.instances.values()) {
      if (instance.win.isDestroyed()) continue
      if (this.clampToVisible(instance)) changed = true
    }
    if (changed) this.emitChange()
  }

  /** 复制当前贴图的标注版（由渲染进程合成后传入 PNG） */
  async copyFor(senderId: number, data: unknown): Promise<SetHotkeyResult> {
    const instance = this.instances.get(senderId)
    if (!instance || instance.win.isDestroyed()) return { ok: false, error: '贴图窗口已关闭' }
    const buffer = toImageBuffer(data)
    if (!buffer) return { ok: false, error: '图片数据无效' }
    const image = nativeImage.createFromBuffer(buffer)
    if (image.isEmpty()) return { ok: false, error: '图片数据无效' }
    clipboard.writeImage(image)
    return { ok: true }
  }

  /** 保存当前贴图的标注版；不写入截图历史 */
  async saveFor(senderId: number, data: unknown): Promise<SetHotkeyResult> {
    const instance = this.instances.get(senderId)
    if (!instance || instance.win.isDestroyed()) return { ok: false, error: '贴图窗口已关闭' }
    const buffer = toImageBuffer(data)
    if (!buffer) return { ok: false, error: '图片数据无效' }
    try {
      const picked = await dialog.showSaveDialog(instance.win, {
        title: '保存贴图',
        defaultPath: join(app.getPath('pictures'), `snip-pin-${Date.now()}.png`),
        filters: [{ name: 'PNG 图片', extensions: ['png'] }],
      })
      if (picked.canceled || !picked.filePath) return { ok: false, error: '已取消' }
      await writeFile(picked.filePath, buffer)
      return { ok: true }
    } catch (error) {
      pinDebug('save failed', error)
      return { ok: false, error: '保存失败' }
    }
  }

  markReady(senderId: number): void {
    const instance = this.instances.get(senderId)
    pinDebug('ready', { senderId, found: Boolean(instance), shown: instance?.shown ?? null })
    if (!instance || instance.shown || instance.win.isDestroyed()) return
    instance.shown = true
    if (instance.readyTimer) {
      clearTimeout(instance.readyTimer)
      instance.readyTimer = null
    }
    instance.win.show()
    // show 后按原属性重申置顶：Windows 上对隐藏窗口设置的 topmost 可能不生效
    instance.win.setAlwaysOnTop(instance.alwaysOnTop)
    instance.win.focus()
    this.scheduleContentSizeFix(instance)
    this.settleReady(instance, this.metaOf(instance))
  }

  private settleReady(instance: PinInstance, meta: PinMeta | null): void {
    if (instance.settled) return
    instance.settled = true
    if (instance.readyTimer) {
      clearTimeout(instance.readyTimer)
      instance.readyTimer = null
    }
    if (meta) instance.resolveReady?.(meta)
    else instance.rejectReady?.(new Error('贴图窗口在显示前被销毁'))
    instance.resolveReady = null
    instance.rejectReady = null
  }

  private failReady(instance: PinInstance, error: Error): void {
    if (!instance.settled) {
      instance.settled = true
      if (instance.readyTimer) {
        clearTimeout(instance.readyTimer)
        instance.readyTimer = null
      }
      pinDebug('ready-failed', { wcId: instance.wcId, error: error.message })
      instance.rejectReady?.(error)
      instance.resolveReady = null
      instance.rejectReady = null
    }
    this.closeFor(instance.wcId)
  }

  /**
   * Windows 对透明无边框窗口的首帧会按物理像素重新取整（多出 1-4 DIP），
   * 单次 setContentSize 不一定收敛；显示后分几次纠正到目标内容尺寸。
   */
  private scheduleContentSizeFix(instance: PinInstance, attempt = 0): void {
    if (instance.win.isDestroyed()) return
    const content = instance.win.getContentBounds()
    if (content.width === instance.contentWidth && content.height === instance.contentHeight) return
    // 只用 setContentSize：在这类透明无边框窗口上 setPosition 会让窗口逐次变大
    instance.win.setContentSize(instance.contentWidth, instance.contentHeight, false)
    if (attempt >= 3) return
    if (instance.geometryTimer) clearTimeout(instance.geometryTimer)
    instance.geometryTimer = setTimeout(() => {
      instance.geometryTimer = null
      this.scheduleContentSizeFix(instance, attempt + 1)
    }, 80)
  }

  private beginGesture(
    senderId: number,
    kind: PointerGesture['kind'],
    direction: PinResizeDirection | null,
    x: unknown,
    y: unknown,
  ): void {
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) return
    const instance = this.instances.get(senderId)
    if (!instance || instance.win.isDestroyed()) return
    if (instance.geometryTimer) {
      clearTimeout(instance.geometryTimer)
      instance.geometryTimer = null
    }
    if (kind === 'move') {
      // 用实际内容尺寸拖动，避免拖动过程中窗口尺寸被二次校正
      const content = instance.win.getContentBounds()
      instance.contentWidth = content.width
      instance.contentHeight = content.height
    }
    this.gestures.set(senderId, {
      kind,
      direction,
      startX: x,
      startY: y,
      startBounds: instance.win.getBounds(),
    })
  }

  private moveGesture(senderId: number, x: unknown, y: unknown): void {
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) return
    const instance = this.instances.get(senderId)
    const gesture = this.gestures.get(senderId)
    if (!instance || !gesture || instance.win.isDestroyed()) return

    const dx = Math.round(x - gesture.startX)
    const dy = Math.round(y - gesture.startY)
    const start = gesture.startBounds

    if (gesture.kind === 'move') {
      // setPosition 会让透明无边框窗口逐次变大，这里带尺寸一起设置
      instance.win.setBounds({
        x: start.x + dx,
        y: start.y + dy,
        width: instance.contentWidth,
        height: instance.contentHeight,
      })
      return
    }

    const direction = gesture.direction
    if (!direction) return
    let nextX = start.x
    let nextY = start.y
    let width = start.width
    let height = start.height

    if (direction.includes('e')) width = Math.max(MIN_PIN_SIZE, start.width + dx)
    if (direction.includes('s')) height = Math.max(MIN_PIN_SIZE, start.height + dy)
    if (direction.includes('w')) {
      width = Math.max(MIN_PIN_SIZE, start.width - dx)
      nextX = start.x + start.width - width
    }
    if (direction.includes('n')) {
      height = Math.max(MIN_PIN_SIZE, start.height - dy)
      nextY = start.y + start.height - height
    }

    instance.win.setBounds({
      x: Math.round(nextX),
      y: Math.round(nextY),
      width: Math.round(width),
      height: Math.round(height),
    })
    instance.contentWidth = Math.round(width)
    instance.contentHeight = Math.round(height)
  }

  dragStart(senderId: number, x: unknown, y: unknown): void {
    this.beginGesture(senderId, 'move', null, x, y)
  }

  dragMove(senderId: number, x: unknown, y: unknown): void {
    this.moveGesture(senderId, x, y)
  }

  dragEnd(senderId: number): void {
    // 移动不改变内容尺寸，结束后不再触发 setContentSize，否则透明窗口会连带位移
    this.gestures.delete(senderId)
  }

  resizeStart(senderId: number, direction: unknown, x: unknown, y: unknown): void {
    if (!isResizeDirection(direction)) return
    this.beginGesture(senderId, 'resize', direction, x, y)
  }

  resizeMove(senderId: number, x: unknown, y: unknown): void {
    this.moveGesture(senderId, x, y)
  }

  resizeEnd(senderId: number): void {
    this.gestures.delete(senderId)
    const instance = this.instances.get(senderId)
    if (!instance || instance.win.isDestroyed()) return
    // 以实际内容尺寸为准，避免再次校正把 1 DIP 取整误差放大
    const content = instance.win.getContentBounds()
    instance.contentWidth = content.width
    instance.contentHeight = content.height
  }

  closeFor(senderId: number): void {
    const instance = this.instances.get(senderId)
    pinDebug('closeFor', { senderId, found: Boolean(instance), destroyed: instance?.win.isDestroyed() ?? true })
    if (!instance || instance.win.isDestroyed()) return
    instance.win.destroy()
  }

  closeAll(): void {
    for (const instance of [...this.instances.values()]) {
      if (!instance.win.isDestroyed()) instance.win.destroy()
    }
  }

  private handleClosed(instance: PinInstance): void {
    pinDebug('closed', { id: instance.id, wcId: instance.wcId, registered: this.instances.has(instance.wcId) })
    if (instance.readyTimer) {
      clearTimeout(instance.readyTimer)
      instance.readyTimer = null
    }
    if (!instance.settled) {
      instance.settled = true
      instance.rejectReady?.(new Error('贴图窗口在显示前被关闭'))
      instance.resolveReady = null
      instance.rejectReady = null
    }
    if (instance.geometryTimer) {
      clearTimeout(instance.geometryTimer)
      instance.geometryTimer = null
    }
    this.gestures.delete(instance.wcId)
    this.instances.delete(instance.wcId)
    void removeFileEventually(instance.imagePath)
    this.emitChange()
  }

  dispose(): void {
    this.closeAll()
    this.gestures.clear()
    this.listeners.clear()
    screen.removeListener('display-metrics-changed', this.handleDisplaysChanged)
    screen.removeListener('display-removed', this.handleDisplaysChanged)
  }
}

export const pinService = new PinService()
