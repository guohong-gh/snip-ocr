/// <reference lib="dom" />
/**
 * 遮罩页标注层。
 * 通过 `Function.prototype.toString()` 序列化后注入，因此函数体必须自包含：
 * 只能引用参数 `deps` 与页面全局，不得引用本模块其它绑定。
 *
 * 笔迹模型与渲染由 src/shared/annotation.ts 注入，与贴图窗共用同一份内核。
 */
import type {
  AnnotationDrawContext,
  AnnotationPoint,
  AnnotationStroke,
  AnnotationTool,
} from '@shared/annotation'

interface ScreenshotsBridge {
  on?: (name: string, callback: (...args: unknown[]) => void) => void
  ok?: (buffer: ArrayBuffer, data: unknown) => void
  save?: (buffer: ArrayBuffer, data: unknown) => void
}

interface AnnotPageWindow extends Window {
  screenshots?: ScreenshotsBridge
  __snipPinRequest?: boolean
  __snipCropSelection?: (options?: { annotations?: boolean }) => string | null
  __snipAnnotRenderInto?: (ctx: AnnotationDrawContext, width: number, height: number) => void
  __snipAnnotStrokes?: () => AnnotationStroke[]
}

interface OverlayRect {
  x: number
  y: number
  width: number
  height: number
}

export interface AnnotationLayerDeps {
  colors: Record<string, string>
  colorLabels: Record<string, string>
  labels: Record<string, string>
  toolOrder: readonly string[]
  colorOrder: readonly string[]
  strokeWidth: number
  createStroke: (
    tool: AnnotationTool,
    color: string,
    surfaceWidth: number,
    point: AnnotationPoint,
    widthPx: number,
  ) => AnnotationStroke
  appendPoint: (stroke: AnnotationStroke, point: AnnotationPoint) => void
  render: (
    ctx: AnnotationDrawContext,
    strokes: readonly AnnotationStroke[],
    width: number,
    height: number,
  ) => void
}

export interface AnnotationLayerApi {
  /** 把标注面板挂到工具栏（重复调用安全） */
  mount(toolbar: HTMLElement): void
  /** 选区出现/消失时同步面板可见性与激活态 */
  sync(): void
  /** 新一次截图：清空笔迹并退出标注模式 */
  reset(): void
  redraw(): void
  hasStrokes(): boolean
  active(): boolean
  strokes(): AnnotationStroke[]
  /** 把笔迹画进目标画布（导出/长图首帧复用） */
  renderInto(ctx: AnnotationDrawContext, width: number, height: number): void
  /** 有笔迹时用合成图走库原有的 ok/save 通道 */
  commit(kind: 'copy' | 'pin' | 'save'): boolean
}

export function installAnnotationLayer(deps: AnnotationLayerDeps): AnnotationLayerApi {
  const page = window as AnnotPageWindow
  const toolIcons: Record<string, string> = {
    pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21l3.6-1.2L20 6.4a2.1 2.1 0 0 0-3-3L3.6 16.8z"/><path d="M14.5 5.5l4 4"/></svg>',
    rect: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5.5" width="17" height="13" rx="1"/></svg>',
    ellipse:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="12" rx="8.5" ry="6.5"/></svg>',
  }
  let strokes: AnnotationStroke[] = []
  let activeTool: string | null = null
  let activeColor = deps.colorOrder[0] || 'red'
  let panel: HTMLDivElement | null = null
  let canvas: HTMLCanvasElement | null = null
  let draft: AnnotationStroke | null = null
  let drawing = false
  let lastDisplay: unknown = null
  let raf = 0
  let committing = false

  function host(): HTMLElement | null {
    const element = document.querySelector('.screenshots-canvas')
    return element instanceof HTMLElement ? element : null
  }

  function hostRect(): DOMRect | null {
    const element = host()
    if (!element) return null
    const rect = element.getBoundingClientRect()
    return rect.width >= 2 && rect.height >= 2 ? rect : null
  }

  function ensureCanvas(): HTMLCanvasElement | null {
    const element = host()
    if (!element) {
      if (canvas && canvas.parentElement) canvas.parentElement.removeChild(canvas)
      return null
    }
    if (!canvas) {
      canvas = document.createElement('canvas')
      canvas.id = 'snip-annot-canvas'
      canvas.setAttribute('aria-hidden', 'true')
    }
    if (canvas.parentElement !== element) element.appendChild(canvas)
    const rect = element.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const width = Math.max(1, Math.round(rect.width * dpr))
    const height = Math.max(1, Math.round(rect.height * dpr))
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    return canvas
  }

  function redraw(): void {
    const element = ensureCanvas()
    if (!element) return
    const ctx = element.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, element.width, element.height)
    deps.render(ctx, strokes, element.width, element.height)
  }

  function scheduleRedraw(): void {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      redraw()
    })
  }

  function hasSelection(): boolean {
    return hostRect() !== null
  }

  function updatePanel(): void {
    if (panel) {
      panel.style.display = hasSelection() ? 'flex' : 'none'
      panel.querySelectorAll<HTMLButtonElement>('[data-snip-annot-tool]').forEach((button) => {
        button.classList.toggle('active', button.dataset.snipAnnotTool === activeTool)
      })
      panel.querySelectorAll<HTMLButtonElement>('[data-snip-annot-color]').forEach((button) => {
        button.classList.toggle('active', button.dataset.snipAnnotColor === activeColor)
      })
    }
    document.body.classList.toggle('snip-annotating', Boolean(activeTool) && hasSelection())
  }

  function mount(toolbar: HTMLElement): void {
    if (!panel || panel.parentElement !== toolbar) {
      if (!panel) {
        panel = document.createElement('div')
        panel.className = 'snip-annot-panel'
        panel.innerHTML =
          '<div class="snip-annot-tools">' +
          deps.toolOrder
            .map(
              (tool) =>
                '<button type="button" class="snip-annot-tool" data-snip-annot-tool="' +
                tool +
                '" title="' +
                (deps.labels[tool] || tool) +
                '">' +
                '<span class="snip-annot-icon">' +
                (toolIcons[tool] || '') +
                '</span>' +
                '<span class="snip-annot-label">' +
                (deps.labels[tool] || tool) +
                '</span>' +
                '</button>',
            )
            .join('') +
          '</div>' +
          '<span class="snip-annot-divider"></span>' +
          '<div class="snip-annot-colors">' +
          deps.colorOrder
            .map(
              (color) =>
                '<button type="button" class="snip-annot-color" data-snip-annot-color="' +
                color +
                '" style="background-color:' +
                (deps.colors[color] || '#000') +
                '" aria-label="' +
                (deps.colorLabels[color] || color) +
                '" title="' +
                (deps.colorLabels[color] || color) +
                '"></button>',
            )
            .join('') +
          '</div>'
        panel.addEventListener('pointerdown', (event) => {
          event.stopPropagation()
        })
        panel.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          const target = event.target
          const button = target instanceof Element ? target.closest('button') : null
          if (!button) return
          const tool = button.getAttribute('data-snip-annot-tool')
          if (tool) {
            activeTool = activeTool === tool ? null : tool
            updatePanel()
            return
          }
          const color = button.getAttribute('data-snip-annot-color')
          if (color) {
            activeColor = color
            updatePanel()
          }
        })
        panel.addEventListener('dblclick', (event) => {
          event.preventDefault()
          event.stopPropagation()
        })
      }
      toolbar.appendChild(panel)
    }
    updatePanel()
  }

  function normalizePoint(clientX: number, clientY: number, rect: DOMRect): AnnotationPoint {
    return {
      x: Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height))),
    }
  }

  function onPointerDown(event: PointerEvent): void {
    if (!activeTool || event.button !== 0) return
    const target = event.target
    if (
      target instanceof Element &&
      target.closest('#snip-toolbar, #snip-ocr-sidebar, #snip-long-hud')
    ) {
      return
    }
    const rect = hostRect()
    if (!rect) return
    const inside =
      event.clientX >= rect.left &&
      event.clientX <= rect.left + rect.width &&
      event.clientY >= rect.top &&
      event.clientY <= rect.top + rect.height
    // 标注模式下选区外的点击也要吞掉，避免误触发重新框选
    event.preventDefault()
    event.stopPropagation()
    if (!inside) return
    const point = normalizePoint(event.clientX, event.clientY, rect)
    draft = deps.createStroke(
      activeTool as AnnotationTool,
      deps.colors[activeColor] || '#e5484d',
      rect.width,
      point,
      deps.strokeWidth,
    )
    strokes.push(draft)
    drawing = true
    redraw()
  }

  function onPointerMove(event: PointerEvent): void {
    if (!drawing || !draft) return
    const rect = hostRect()
    if (!rect) return
    event.preventDefault()
    event.stopPropagation()
    deps.appendPoint(draft, normalizePoint(event.clientX, event.clientY, rect))
    redraw()
  }

  function finishStroke(event: PointerEvent): void {
    if (!drawing) return
    drawing = false
    draft = null
    event.preventDefault()
    event.stopPropagation()
    redraw()
  }

  window.addEventListener('pointerdown', onPointerDown, { capture: true, passive: false })
  window.addEventListener('pointermove', onPointerMove, { capture: true, passive: false })
  window.addEventListener('pointerup', finishStroke, { capture: true, passive: false })
  window.addEventListener('pointercancel', finishStroke, { capture: true, passive: false })

  function selectionBounds(): OverlayRect | null {
    const rect = hostRect()
    if (!rect) return null
    return {
      x: Math.round(rect.left * 100) / 100,
      y: Math.round(rect.top * 100) / 100,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
    }
  }

  function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer | null {
    const comma = dataUrl.indexOf(',')
    if (comma < 0) return null
    try {
      const binary = atob(dataUrl.slice(comma + 1))
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      return bytes.buffer
    } catch {
      return null
    }
  }

  function commit(kind: 'copy' | 'pin' | 'save'): boolean {
    if (committing) return false
    const bridge = page.screenshots
    const exportFn = page.__snipCropSelection
    const bounds = selectionBounds()
    const dataUrl = exportFn ? exportFn({ annotations: true }) : null
    if (!bridge || !dataUrl || !bounds || !lastDisplay) return false
    const buffer = dataUrlToArrayBuffer(dataUrl)
    if (!buffer) return false
    committing = true
    setTimeout(() => {
      committing = false
    }, 800)
    if (kind === 'save') {
      if (!bridge.save) return false
      bridge.save(buffer, { bounds, display: lastDisplay })
      return true
    }
    if (!bridge.ok) return false
    if (kind === 'pin') page.__snipPinRequest = true
    bridge.ok(buffer, { bounds, display: lastDisplay })
    return true
  }

  if (page.screenshots && typeof page.screenshots.on === 'function') {
    page.screenshots.on('capture', (...args: unknown[]) => {
      lastDisplay = args[0] ?? null
      strokes = []
      draft = null
      drawing = false
      activeTool = null
      updatePanel()
      scheduleRedraw()
    })
  }

  page.__snipAnnotRenderInto = (ctx, width, height) => {
    deps.render(ctx, strokes, width, height)
  }
  page.__snipAnnotStrokes = () => strokes.slice()

  return {
    mount,
    sync: () => {
      updatePanel()
      ensureCanvas()
      scheduleRedraw()
    },
    reset: () => {
      strokes = []
      draft = null
      drawing = false
      activeTool = null
      updatePanel()
      redraw()
    },
    redraw,
    hasStrokes: () => strokes.length > 0,
    active: () => Boolean(activeTool) && hasSelection(),
    strokes: () => strokes.slice(),
    renderInto: (ctx, width, height) => deps.render(ctx, strokes, width, height),
    commit,
  }
}
