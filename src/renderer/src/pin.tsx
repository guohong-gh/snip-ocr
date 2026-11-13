import { StrictMode, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { PIN_RESIZE_DIRECTIONS, type PinMeta, type PinResizeDirection } from '@shared/ipc'
import {
  ANNOTATION_COLORS,
  ANNOTATION_COLOR_LABELS,
  ANNOTATION_COLOR_ORDER,
  ANNOTATION_STROKE_WIDTH,
  ANNOTATION_TOOL_LABELS,
  ANNOTATION_TOOLS,
  appendAnnotationPoint,
  createAnnotationStroke,
  eraseAnnotationStrokes,
  isPointOnAnnotation,
  renderAnnotations,
  type AnnotationColor,
  type AnnotationStroke,
  type AnnotationTool,
} from '@shared/annotation'
import './pin.css'

const DRAG_SLOP = 3
/** 回传列表缩略图的最长边（像素），主进程会再按需要缩放 */
const THUMB_MAX_SIDE = 192
const THUMB_DELAY_MS = 200

const imageUrl = new URLSearchParams(window.location.search).get('image')

function closePin(reason: string): void {
  console.info(`[pin-view] close: ${reason}`)
  window.snipPin.close()
}

type GestureMode = 'idle' | 'move' | 'resize'

function ToolIcon({ tool }: { tool: AnnotationTool }) {
  if (tool === 'pen') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 21l3.6-1.2L20 6.4a2.1 2.1 0 0 0-3-3L3.6 16.8z" />
        <path d="M14.5 5.5l4 4" />
      </svg>
    )
  }
  if (tool === 'rect') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3.5" y="5.5" width="17" height="13" rx="1" />
      </svg>
    )
  }
  if (tool === 'ellipse') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="12" cy="12" rx="8.5" ry="6.5" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 13l-5.5 5.5a2 2 0 0 1-2.8 0L4.2 13a2 2 0 0 1 0-2.8L10 4.4a2 2 0 0 1 2.8 0l5.2 5.2a2 2 0 0 1 0 2.8z" />
      <path d="M8.5 9.5l6 6" />
      <path d="M7 20h12" />
    </svg>
  )
}

function capturePointer(target: HTMLElement, pointerId: number): void {
  try {
    target.setPointerCapture(pointerId)
  } catch {
    // 合成事件没有活动指针，忽略
  }
}

function PinView() {
  const gesture = useRef<GestureMode>('idle')
  const startPoint = useRef({ x: 0, y: 0 })
  const moved = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const geometryRef = useRef({
    viewportWidth: 0,
    viewportHeight: 0,
    baseWidth: 0,
    baseHeight: 0,
    baseX: 0,
    baseY: 0,
  })
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 })
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const [meta, setMeta] = useState<PinMeta | null>(null)
  const [tool, setTool] = useState<AnnotationTool | null>(null)
  const [color, setColor] = useState<AnnotationColor>('red')
  const [strokes, setStrokes] = useState<AnnotationStroke[]>([])
  const [hint, setHint] = useState('')
  const annotCanvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const draft = useRef<AnnotationStroke | null>(null)
  const flashTimer = useRef<number | null>(null)
  const strokesRef = useRef<AnnotationStroke[]>([])
  const thumbTimer = useRef<number | null>(null)
  const erasing = useRef(false)
  const erased = useRef(false)

  useEffect(() => {
    strokesRef.current = strokes
  }, [strokes])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const update = (): void => {
      const rect = root.getBoundingClientRect()
      setViewport({ width: rect.width, height: rect.height })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const onWheel = (event: WheelEvent): void => {
      // 滚轮只缩放窗口内的图片内容，窗口大小仍由 8 向拖拽调整
      event.preventDefault()
      const rect = rootRef.current?.getBoundingClientRect()
      const geometry = geometryRef.current
      if (!rect || geometry.baseWidth <= 0 || geometry.baseHeight <= 0) return
      const cx = event.clientX - rect.left
      const cy = event.clientY - rect.top
      setView((prev) => {
        const factor = Math.pow(1.1, -event.deltaY / 100)
        const zoom = Math.min(8, Math.max(0.25, prev.zoom * factor))
        if (Math.abs(zoom - prev.zoom) < 0.0001) return prev
        if (zoom <= 1) {
          return { zoom, x: 0, y: 0 }
        }
        const ratio = zoom / prev.zoom
        // zoom <= 1 时图片居中绘制，锚点要按居中后的实际位置算
        const previousX =
          prev.zoom <= 1
            ? (geometry.viewportWidth - geometry.baseWidth * prev.zoom) / 2
            : geometry.baseX + prev.x
        const previousY =
          prev.zoom <= 1
            ? (geometry.viewportHeight - geometry.baseHeight * prev.zoom) / 2
            : geometry.baseY + prev.y
        return {
          zoom,
          x: cx - (cx - previousX) * ratio - geometry.baseX,
          y: cy - (cy - previousY) * ratio - geometry.baseY,
        }
      })
      scheduleThumbnail()
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    if (!imageUrl) closePin('missing-image')
  }, [])

  useEffect(() => {
    let alive = true
    void window.snipPin.meta().then((next) => {
      if (alive) setMeta(next)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        closePin('escape')
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key === '0') {
        event.preventDefault()
        setView({ zoom: 1, x: 0, y: 0 })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // 图片基准尺寸按"适应窗口"计算，并取整到设备像素（DPR 1.25/1.5 下避免亚像素栅格化发虚）。
  // 图片和边框都从这里取值，保证二者始终同一坐标系、同一尺寸。
  const naturalSize = natural ?? (meta ? { width: meta.imageWidth, height: meta.imageHeight } : null)
  const dpr = Math.max(1, window.devicePixelRatio || 1)
  const roundToDevice = (value: number): number => Math.round(value * dpr) / dpr
  let baseWidth = 0
  let baseHeight = 0
  let baseX = 0
  let baseY = 0
  if (naturalSize && viewport.width > 0 && viewport.height > 0) {
    const fit = Math.min(viewport.width / naturalSize.width, viewport.height / naturalSize.height)
    baseWidth = roundToDevice(naturalSize.width * fit)
    baseHeight = roundToDevice(naturalSize.height * fit)
    baseX = (viewport.width - baseWidth) / 2
    baseY = (viewport.height - baseHeight) / 2
  }
  const hasGeometry = baseWidth > 0 && baseHeight > 0
  const drawnWidth = baseWidth * view.zoom
  const drawnHeight = baseHeight * view.zoom
  // zoom ≤ 1 时始终居中；> 1 时按滚轮锚点平移。落点同样取整到设备像素，避免半像素重采样发虚。
  const imageLeft = roundToDevice(
    view.zoom <= 1 ? (viewport.width - drawnWidth) / 2 : baseX + view.x,
  )
  const imageTop = roundToDevice(
    view.zoom <= 1 ? (viewport.height - drawnHeight) / 2 : baseY + view.y,
  )
  // 边框取图片可见区域的交集：图片铺满/超出窗口时即窗口边缘，留白时紧贴图片
  const frameLeft = Math.max(0, imageLeft)
  const frameTop = Math.max(0, imageTop)
  const frameWidth = Math.max(0, Math.min(viewport.width, imageLeft + drawnWidth) - frameLeft)
  const frameHeight = Math.max(0, Math.min(viewport.height, imageTop + drawnHeight) - frameTop)

  useEffect(() => {
    geometryRef.current = {
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      baseWidth,
      baseHeight,
      baseX,
      baseY,
    }
  }, [viewport.width, viewport.height, baseWidth, baseHeight, baseX, baseY])

  // 标注画布跟随图片同一组几何变换，内部像素按 DPR 放大保证笔迹清晰
  useEffect(() => {
    const canvas = annotCanvasRef.current
    if (!canvas) return
    const width = Math.max(1, Math.round(baseWidth * dpr))
    const height = Math.max(1, Math.round(baseHeight * dpr))
    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    renderAnnotations(ctx, strokes, canvas.width, canvas.height)
  }, [strokes, baseWidth, baseHeight, dpr])

  useEffect(() => {
    return () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
      if (thumbTimer.current !== null) window.clearTimeout(thumbTimer.current)
    }
  }, [])

  const flash = (text: string): void => {
    setHint(text)
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => {
      flashTimer.current = null
      setHint('')
    }, 1600)
  }

  const annotationPoint = (event: ReactPointerEvent<HTMLElement>) => {
    const canvas = annotCanvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return null
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    }
  }

  const onToolSelect = (next: AnnotationTool): void => {
    setTool((prev) => (prev === next ? null : next))
    draft.current = null
    erasing.current = false
  }

  /** 橡皮擦：整笔删除当前指针命中的笔迹，一次拖动可连续擦 */
  const eraseAt = (event: ReactPointerEvent<HTMLElement>): void => {
    const canvas = annotCanvasRef.current
    const point = annotationPoint(event)
    if (!canvas || !point) return
    const rect = canvas.getBoundingClientRect()
    const width = Math.max(1, rect.width)
    const height = Math.max(1, rect.height)
    const next = strokesRef.current.slice()
    const removed = eraseAnnotationStrokes(next, (stroke) =>
      isPointOnAnnotation(stroke, point.x * width, point.y * height, width, height),
    )
    if (removed === 0) return
    strokesRef.current = next
    erased.current = true
    setStrokes(next)
  }

  /** 导出标注版：按原图像素重绘图片 + 笔迹，复制/保存都走这里 */
  const renderAnnotatedPng = async (): Promise<ArrayBuffer | null> => {
    const image = imageRef.current
    if (!image || !natural) return null
    const canvas = document.createElement('canvas')
    canvas.width = natural.width
    canvas.height = natural.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(image, 0, 0, natural.width, natural.height)
    renderAnnotations(ctx, strokes, natural.width, natural.height)
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((value) => resolve(value), 'image/png')
    })
    return blob ? blob.arrayBuffer() : null
  }

  /** 回传带笔迹的列表缩略图：直接按缩略尺寸重绘，不传整张原图 */
  const pushThumbnail = async (): Promise<void> => {
    const image = imageRef.current
    if (!image || image.naturalWidth <= 0 || image.naturalHeight <= 0) return
    const ratio = Math.min(1, THUMB_MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight))
    const width = Math.max(1, Math.round(image.naturalWidth * ratio))
    const height = Math.max(1, Math.round(image.naturalHeight * ratio))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(image, 0, 0, width, height)
    renderAnnotations(ctx, strokesRef.current, width, height)
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((value) => resolve(value), 'image/png')
    })
    if (!blob) return
    window.snipPin.thumbnail(await blob.arrayBuffer())
  }

  /** 首次加载、落笔结束、缩放结束后各回传一次，短时间内的多次变化合并 */
  const scheduleThumbnail = (): void => {
    if (thumbTimer.current !== null) window.clearTimeout(thumbTimer.current)
    thumbTimer.current = window.setTimeout(() => {
      thumbTimer.current = null
      void pushThumbnail()
    }, THUMB_DELAY_MS)
  }

  const copyAnnotated = async (): Promise<void> => {
    const data = await renderAnnotatedPng()
    if (!data) return
    const result = await window.snipPin.copy(data)
    flash(result.ok ? '已复制' : (result.error ?? '复制失败'))
  }

  const saveAnnotated = async (): Promise<void> => {
    const data = await renderAnnotatedPng()
    if (!data) return
    const result = await window.snipPin.save(data)
    if (!result.ok && result.error === '已取消') return
    flash(result.ok ? '已保存' : (result.error ?? '保存失败'))
  }

  const stopToolbarPointer = (event: ReactPointerEvent<HTMLElement>): void => {
    event.preventDefault()
    event.stopPropagation()
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    if (tool) {
      const point = annotationPoint(event)
      if (!point) return
      event.preventDefault()
      event.stopPropagation()
      if (tool === 'eraser') {
        erasing.current = true
        erased.current = false
        eraseAt(event)
        capturePointer(event.currentTarget, event.pointerId)
        return
      }
      draft.current = createAnnotationStroke(
        tool,
        ANNOTATION_COLORS[color],
        Math.max(1, baseWidth),
        point,
        ANNOTATION_STROKE_WIDTH,
      )
      setStrokes((prev) => [...prev, draft.current as AnnotationStroke])
      capturePointer(event.currentTarget, event.pointerId)
      return
    }
    if (gesture.current !== 'idle') return
    gesture.current = 'move'
    moved.current = false
    startPoint.current = { x: event.screenX, y: event.screenY }
    capturePointer(event.currentTarget, event.pointerId)
    window.snipPin.dragStart(event.screenX, event.screenY)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (tool === 'eraser' && erasing.current) {
      event.preventDefault()
      event.stopPropagation()
      eraseAt(event)
      return
    }
    if (tool && draft.current) {
      const point = annotationPoint(event)
      if (!point) return
      event.preventDefault()
      event.stopPropagation()
      appendAnnotationPoint(draft.current, point)
      const next = { ...draft.current, points: draft.current.points.slice() }
      setStrokes((prev) => prev.map((stroke, index) => (index === prev.length - 1 ? next : stroke)))
      return
    }
    if (gesture.current === 'idle') return
    if (
      Math.abs(event.screenX - startPoint.current.x) > DRAG_SLOP ||
      Math.abs(event.screenY - startPoint.current.y) > DRAG_SLOP
    ) {
      moved.current = true
    }
    if (gesture.current === 'move') window.snipPin.dragMove(event.screenX, event.screenY)
    else window.snipPin.resizeMove(event.screenX, event.screenY)
  }

  const finishGesture = (): void => {
    if (gesture.current === 'move') {
      window.snipPin.dragEnd()
      gesture.current = 'idle'
      return
    }
    if (gesture.current === 'resize') {
      window.snipPin.resizeEnd()
      gesture.current = 'idle'
    }
  }

  const onPointerUp = (): void => {
    if (tool) {
      if (tool === 'eraser') {
        erasing.current = false
        // 擦除后也要回传一次，否则列表面板仍是旧缩略图
        if (erased.current) scheduleThumbnail()
        erased.current = false
        return
      }
      draft.current = null
      scheduleThumbnail()
      return
    }
    finishGesture()
  }

  const onPointerCancel = (): void => {
    if (tool) {
      if (tool === 'eraser') {
        erasing.current = false
        if (erased.current) scheduleThumbnail()
        erased.current = false
        return
      }
      draft.current = null
      scheduleThumbnail()
      return
    }
    finishGesture()
  }

  const onHandlePointerDown = (direction: PinResizeDirection) => {
    return (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (tool) return
      if (event.button !== 0 || gesture.current !== 'idle') return
      event.preventDefault()
      event.stopPropagation()
      gesture.current = 'resize'
      moved.current = false
      startPoint.current = { x: event.screenX, y: event.screenY }
      capturePointer(event.currentTarget, event.pointerId)
      window.snipPin.resizeStart(direction, event.screenX, event.screenY)
    }
  }

  return (
    <div
      ref={rootRef}
      className={`pin-root${tool ? ' pin-drawing' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={(event) => event.preventDefault()}
    >
      {imageUrl ? (
        <img
          ref={imageRef}
          className="pin-image"
          src={imageUrl}
          alt=""
          draggable={false}
          style={
            hasGeometry
              ? {
                  width: `${baseWidth}px`,
                  height: `${baseHeight}px`,
                  transform: `translate(${imageLeft}px, ${imageTop}px) scale(${view.zoom})`,
                }
              : undefined
          }
          onDragStart={(event) => event.preventDefault()}
          onLoad={(event) => {
            const image = event.currentTarget
            setNatural({ width: image.naturalWidth, height: image.naturalHeight })
            window.snipPin.ready()
            scheduleThumbnail()
          }}
          onError={() => closePin('image-error')}
        />
      ) : null}
      {imageUrl && hasGeometry ? (
        <canvas
          ref={annotCanvasRef}
          className="pin-annot-canvas"
          aria-hidden="true"
          style={{
            width: `${baseWidth}px`,
            height: `${baseHeight}px`,
            transform: `translate(${imageLeft}px, ${imageTop}px) scale(${view.zoom})`,
          }}
        />
      ) : null}
      <div
        className="pin-frame"
        style={
          hasGeometry
            ? {
                left: `${frameLeft}px`,
                top: `${frameTop}px`,
                width: `${frameWidth}px`,
                height: `${frameHeight}px`,
              }
            : undefined
        }
      />
      {PIN_RESIZE_DIRECTIONS.map((direction) => (
        <div
          key={direction}
          className={`pin-handle pin-handle-${direction}`}
          onPointerDown={onHandlePointerDown(direction)}
        />
      ))}
      <div className="pin-bar">
        <span className="pin-tag">PIN</span>
        {meta ? (
          <span className="pin-dims">
            {meta.imageWidth} × {meta.imageHeight}
          </span>
        ) : null}
        <span className="pin-zoom">{Math.round(view.zoom * 100)}%</span>
        <span className="pin-tools">
          {ANNOTATION_TOOLS.map((key) => (
            <button
              key={key}
              type="button"
              className={`pin-tool${tool === key ? ' active' : ''}`}
              data-pin-tool={key}
              aria-label={ANNOTATION_TOOL_LABELS[key]}
              title={ANNOTATION_TOOL_LABELS[key]}
              onPointerDown={stopToolbarPointer}
              onPointerUp={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                onToolSelect(key)
              }}
            >
              <ToolIcon tool={key} />
            </button>
          ))}
        </span>
        <span className="pin-tools-divider" />
        <span className="pin-colors">
          {ANNOTATION_COLOR_ORDER.map((name) => (
            <button
              key={name}
              type="button"
              className={`pin-color${tool !== 'eraser' && color === name ? ' active' : ''}`}
              data-pin-color={name}
              disabled={tool === 'eraser'}
              style={{ backgroundColor: ANNOTATION_COLORS[name] }}
              aria-label={ANNOTATION_COLOR_LABELS[name]}
              title={ANNOTATION_COLOR_LABELS[name]}
              onPointerDown={stopToolbarPointer}
              onPointerUp={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                setColor(name)
              }}
            />
          ))}
        </span>
        <span className="pin-hint">{hint}</span>
        <button
          type="button"
          className="pin-action"
          data-pin-action="copy"
          onPointerDown={stopToolbarPointer}
          onPointerUp={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            void copyAnnotated()
          }}
        >
          复制
        </button>
        <button
          type="button"
          className="pin-action"
          data-pin-action="save"
          onPointerDown={stopToolbarPointer}
          onPointerUp={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            void saveAnnotated()
          }}
        >
          保存
        </button>
      </div>
      <button
        type="button"
        className="pin-close"
        aria-label="关闭贴图"
        title="关闭贴图"
        onPointerDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        onPointerUp={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          closePin('button')
        }}
      >
        ×
      </button>
    </div>
  )
}

const host = document.getElementById('root')
if (!host) throw new Error('#root not found')

createRoot(host).render(
  <StrictMode>
    <PinView />
  </StrictMode>,
)
