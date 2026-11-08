/// <reference lib="dom" />
/**
 * 长图 HUD / 抓帧脚本片段。
 * 通过 `Function.prototype.toString()` 序列化后注入遮罩页，因此函数体必须自包含：
 * 只能引用参数 `deps` 与页面全局（window / document / canvas 等），不得引用本模块其它绑定。
 */

export interface OverlayRect {
  x: number
  y: number
  width: number
  height: number
}

export interface LongShotFramePayload {
  dataUrl?: string
  bounds?: OverlayRect
  crop?: OverlayRect
}

export interface LongShotStatePayload {
  phase?: 'follow' | 'done'
  count?: number
  scrolling?: boolean
  height?: number
  width?: number
  segments?: number
}

export interface LongShotHudDeps {
  /** 遮罩动作 console 前缀 */
  actionPrefix: string
  /** 读取最新图标（主题切换后 ICONS 会被原地更新） */
  icons: () => Record<string, string>
  /** 上报 HUD 与侧栏矩形 */
  reportRects: () => void
  /** 收起 OCR 侧栏 */
  hideSidebar: () => void
  /** OCR 是否进行中 */
  isOcrBusy: () => boolean
  /** 进入长图 OCR 态（置忙 + 打开侧栏） */
  beginLongOcr: () => void
}

export interface LongShotHudApi {
  /** 供宿主在 reportRects 中读取 HUD 元素 */
  hudElement: () => HTMLElement | null
}

interface LongShotState {
  phase: 'follow' | 'done'
  count?: number
  scrolling?: boolean
  height?: number
  width?: number
  segments?: number
}

interface LongShotAppendResult {
  rows: number
  width: number
  height: number
}

interface SnipPageWindow extends Window {
  __snipLongFrame?: (payload: LongShotFramePayload) => Promise<string | null>
  __snipLongAppend?: (startRow: number) => LongShotAppendResult | null
  __snipLongStart?: (bounds: OverlayRect) => void
  __snipLongState?: (state: LongShotStatePayload) => void
  __snipLongEnd?: () => void
}

export function installLongShotHud(deps: LongShotHudDeps): LongShotHudApi {
  const page = window as SnipPageWindow

  let longBounds: OverlayRect | null = null
  let longState: LongShotState | null = null
  let longBorder: HTMLDivElement | null = null
  let longHud: HTMLDivElement | null = null
  let longPreview: HTMLDivElement | null = null
  let longPreviewCanvas: HTMLCanvasElement | null = null
  let longPreviewRows = 0
  let longFrameCanvas: HTMLCanvasElement | null = null
  const PREVIEW_DIP = 180
  const PREVIEW_GAP = 10

  function ensureLongNodes(): { border: HTMLDivElement; hud: HTMLDivElement } {
    if (!longBorder) {
      longBorder = document.createElement('div')
      longBorder.id = 'snip-long-border'
      document.body.appendChild(longBorder)
    }
    if (!longHud) {
      longHud = document.createElement('div')
      longHud.id = 'snip-long-hud'
      longHud.addEventListener('click', (event) => {
        const target = event.target
        const button = target instanceof Element ? target.closest('[data-snip-long]') : null
        if (!button) return
        event.preventDefault()
        event.stopPropagation()
        const action = button.getAttribute('data-snip-long')
        if (action === 'longshot-ocr') {
          if (deps.isOcrBusy()) return
          deps.beginLongOcr()
        }
        console.log(deps.actionPrefix + JSON.stringify({ action: action, requestId: Date.now() }))
      })
      document.body.appendChild(longHud)
    }
    return { border: longBorder, hud: longHud }
  }

  function ensureLongPreview(): { wrap: HTMLDivElement; canvas: HTMLCanvasElement } {
    if (!longPreview || !longPreviewCanvas) {
      longPreview = document.createElement('div')
      longPreview.id = 'snip-long-preview'
      longPreviewCanvas = document.createElement('canvas')
      longPreview.appendChild(longPreviewCanvas)
      document.body.appendChild(longPreview)
    }
    return { wrap: longPreview, canvas: longPreviewCanvas }
  }

  function previewOverlap(rect: OverlayRect): boolean {
    const b = longBounds
    if (!b) return true
    return rect.x < b.x + b.width && rect.x + rect.width > b.x && rect.y < b.y + b.height && rect.y + rect.height > b.y
  }

  function positionLongPreview(): void {
    if (!longPreview || !longPreviewCanvas || !longPreviewCanvas.width || longPreviewRows < 1 || !longBounds) {
      if (longPreview) longPreview.style.display = 'none'
      return
    }
    const viewW = window.innerWidth
    const viewH = window.innerHeight
    const maxHeight = Math.floor(viewH * 0.6)
    const ratio = longPreviewCanvas.height / longPreviewCanvas.width
    const b = longBounds
    const gap = PREVIEW_GAP
    const candidates = [
      { side: 'right', x: b.x + b.width + gap, y: b.y, availW: viewW - (b.x + b.width) - gap * 2, availH: viewH },
      { side: 'left', x: b.x - gap, y: b.y, availW: b.x - gap * 2, availH: viewH },
      { side: 'bottom', x: b.x, y: b.y + b.height + gap, availW: viewW, availH: viewH - (b.y + b.height) - gap * 2 },
      { side: 'top', x: b.x, y: b.y - gap, availW: viewW, availH: b.y - gap * 2 },
    ]
    let chosen: OverlayRect | null = null
    for (const candidate of candidates) {
      if (candidate.availW < 80 || candidate.availH < 60) continue
      let width = Math.min(PREVIEW_DIP, candidate.availW)
      let height = Math.min(maxHeight, Math.round(width * ratio), candidate.availH)
      width = Math.round(height / ratio)
      if (width < 80) continue
      let x = candidate.side === 'right' ? candidate.x : candidate.side === 'left' ? b.x - gap - width : b.x
      let y = candidate.side === 'bottom' ? candidate.y : candidate.side === 'top' ? b.y - gap - height : b.y
      x = Math.max(8, Math.min(Math.round(x), viewW - width - 8))
      y = Math.max(8, Math.min(Math.round(y), viewH - height - 8))
      const rect = { x: x, y: y, width: width, height: height }
      if (!previewOverlap(rect)) {
        chosen = rect
        break
      }
    }
    if (!chosen) {
      // 选区几乎铺满屏幕：取空间最大的一侧缩小到刚好不压选区
      const width = Math.min(PREVIEW_DIP, Math.max(60, Math.max(b.x - gap * 2, viewW - (b.x + b.width) - gap * 2)))
      const height = Math.max(40, Math.min(maxHeight, Math.round(width * ratio)))
      chosen = { x: b.x + b.width + gap, y: Math.max(8, Math.min(b.y, viewH - height - 8)), width: width, height: height }
    }
    longPreview.style.display = 'block'
    longPreview.style.left = chosen.x + 'px'
    longPreview.style.top = chosen.y + 'px'
    longPreviewCanvas.style.width = chosen.width + 'px'
    longPreviewCanvas.style.height = chosen.height + 'px'
  }

  page.__snipLongFrame = (payload) =>
    new Promise((resolve) => {
      if (!payload || typeof payload !== 'object' || typeof payload.dataUrl !== 'string') {
        resolve(null)
        return
      }
      const img = new Image()
      img.onload = () => {
        const bounds = payload.bounds || { x: 0, y: 0, width: 0, height: 0 }
        const crop = payload.crop || { x: 0, y: 0, width: 0, height: 0 }
        const dpr = window.devicePixelRatio || 1
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(bounds.width * dpr))
        canvas.height = Math.max(1, Math.round(bounds.height * dpr))
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(null)
          return
        }
        const rx = img.naturalWidth / (crop.width || 1)
        const ry = img.naturalHeight / (crop.height || 1)
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'low'
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, bounds.width, bounds.height)
        ctx.drawImage(
          img,
          (bounds.x - crop.x) * rx,
          (bounds.y - crop.y) * ry,
          bounds.width * rx,
          bounds.height * ry,
          0,
          0,
          bounds.width,
          bounds.height,
        )
        longFrameCanvas = canvas
        resolve(canvas.toDataURL('image/png'))
      }
      img.onerror = () => resolve(null)
      img.src = payload.dataUrl
    })

  page.__snipLongAppend = (startRow) => {
    const frame = longFrameCanvas
    if (!frame || !frame.width || !frame.height) return null
    const dpr = window.devicePixelRatio || 1
    const targetW = Math.max(1, Math.round(PREVIEW_DIP * dpr))
    const scale = targetW / frame.width
    const skip = Math.max(0, Math.min(frame.height, Math.round(Number(startRow) || 0)))
    const rows = frame.height - skip
    if (rows < 1) return { rows: longPreviewRows, width: 0, height: 0 }
    const preview = ensureLongPreview()
    let previous: HTMLCanvasElement | null = null
    if (preview.canvas.width && preview.canvas.height) {
      previous = document.createElement('canvas')
      previous.width = preview.canvas.width
      previous.height = preview.canvas.height
      const prevCtx = previous.getContext('2d')
      if (prevCtx) prevCtx.drawImage(preview.canvas, 0, 0)
    }
    const baseRows = longPreviewRows
    longPreviewRows += rows
    preview.canvas.width = targetW
    preview.canvas.height = Math.max(1, Math.round(longPreviewRows * scale))
    const ctx = preview.canvas.getContext('2d')
    if (!ctx) return null
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    if (previous) ctx.drawImage(previous, 0, 0)
    ctx.drawImage(frame, 0, skip, frame.width, rows, 0, Math.round(baseRows * scale), targetW, Math.round(rows * scale))
    positionLongPreview()
    return { rows: longPreviewRows, width: preview.canvas.width, height: preview.canvas.height }
  }

  function longHudButton(tool: string, action: string, label: string): string {
    return (
      '<button type="button" class="snip-tool-btn" data-snip-tool="' + tool + '" data-snip-long="' + action + '">' +
      '<span class="snip-tool-icon">' + (deps.icons()[tool] || '') + '</span>' +
      '<span class="snip-tool-label">' + label + '</span>' +
      '</button>'
    )
  }

  function renderLongHud(): void {
    const nodes = ensureLongNodes()
    const bounds = longBounds || { x: 0, y: 0, width: 0, height: 0 }
    nodes.border.style.display = 'block'
    nodes.border.style.left = Math.round(bounds.x - 2) + 'px'
    nodes.border.style.top = Math.round(bounds.y - 2) + 'px'
    nodes.border.style.width = Math.round(bounds.width + 4) + 'px'
    nodes.border.style.height = Math.round(bounds.height + 4) + 'px'
    const state = longState || { phase: 'follow', count: 1 }
    let html: string
    if (state.phase === 'done') {
      const size = (state.width || 0) + ' × ' + (state.height || 0)
      html =
        '<span class="snip-hud-text">已完成 · ' + size + ((state.segments ?? 0) > 1 ? ' · ' + state.segments + ' 段' : '') + '</span>' +
        longHudButton('confirm', 'longshot-copy', '复制') +
        longHudButton('save', 'longshot-save', '另存') +
        longHudButton('ocr', 'longshot-ocr', 'OCR') +
        longHudButton('cancel', 'longshot-close', '关闭')
    } else {
      const hint = state.scrolling ? '采集中…' : '滚动页面，到底自动结束'
      const height = state.height ? ' · ' + state.height + ' px' : ''
      html =
        '<span class="snip-hud-dot"></span>' +
        '<span class="snip-hud-text">长截图 · 第 ' + (state.count || 1) + ' 段' + height + '</span>' +
        '<span class="snip-hud-hint">' + hint + '</span>' +
        longHudButton('confirm', 'longshot-finish', '完成') +
        longHudButton('cancel', 'longshot-cancel', '取消')
    }
    nodes.hud.innerHTML = html
    nodes.hud.style.display = 'flex'
    const hudWidth = nodes.hud.offsetWidth
    const hudHeight = nodes.hud.offsetHeight
    let left = Math.round(bounds.x + bounds.width - hudWidth)
    let top = Math.round(bounds.y - hudHeight - 10)
    if (top < 8) top = Math.round(bounds.y + bounds.height + 10)
    // HUD 变高后可能两端都放不下，最后统一夹回视口内，避免跑出屏幕
    top = Math.max(8, Math.min(top, window.innerHeight - hudHeight - 8))
    left = Math.max(8, Math.min(left, window.innerWidth - hudWidth - 8))
    nodes.hud.style.left = left + 'px'
    nodes.hud.style.top = top + 'px'
    positionLongPreview()
    deps.reportRects()
  }

  page.__snipLongStart = (bounds) => {
    if (!bounds || typeof bounds !== 'object') return
    longBounds = bounds
    longState = { phase: 'follow', count: 1, scrolling: false }
    longPreviewRows = 0
    longFrameCanvas = null
    if (longPreviewCanvas) {
      longPreviewCanvas.width = 0
      longPreviewCanvas.height = 0
    }
    if (longPreview) longPreview.style.display = 'none'
    deps.hideSidebar()
    document.body.classList.add('snip-long')
    renderLongHud()
  }

  page.__snipLongState = (state) => {
    if (!state || typeof state !== 'object') return
    longState = Object.assign({}, longState, state) as LongShotState
    renderLongHud()
  }

  page.__snipLongEnd = () => {
    longBounds = null
    longState = null
    longPreviewRows = 0
    longFrameCanvas = null
    document.body.classList.remove('snip-long')
    if (longBorder) longBorder.style.display = 'none'
    if (longHud) longHud.style.display = 'none'
    if (longPreview) longPreview.style.display = 'none'
    if (longPreviewCanvas) {
      longPreviewCanvas.width = 0
      longPreviewCanvas.height = 0
    }
    deps.reportRects()
  }

  return { hudElement: () => longHud }
}
