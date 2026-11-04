import { StrictMode, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { createRoot } from 'react-dom/client'
import { PIN_RESIZE_DIRECTIONS, type PinMeta, type PinResizeDirection } from '@shared/ipc'
import './pin.css'

const DOUBLE_CLICK_MS = 350
const DOUBLE_CLICK_SLOP = 5
const DRAG_SLOP = 3

const imageUrl = new URLSearchParams(window.location.search).get('image')

function closePin(reason: string): void {
  console.info(`[pin-view] close: ${reason}`)
  window.snip.pin.close()
}

type GestureMode = 'idle' | 'move' | 'resize'

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
  const lastTap = useRef<{ time: number; x: number; y: number } | null>(null)
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
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    if (!imageUrl) closePin('missing-image')
  }, [])

  useEffect(() => {
    let alive = true
    void window.snip.pin.meta().then((next) => {
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

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || gesture.current !== 'idle') return
    gesture.current = 'move'
    moved.current = false
    startPoint.current = { x: event.screenX, y: event.screenY }
    capturePointer(event.currentTarget, event.pointerId)
    window.snip.pin.dragStart(event.screenX, event.screenY)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (gesture.current === 'idle') return
    if (
      Math.abs(event.screenX - startPoint.current.x) > DRAG_SLOP ||
      Math.abs(event.screenY - startPoint.current.y) > DRAG_SLOP
    ) {
      moved.current = true
    }
    if (gesture.current === 'move') window.snip.pin.dragMove(event.screenX, event.screenY)
    else window.snip.pin.resizeMove(event.screenX, event.screenY)
  }

  const finishGesture = (event: ReactPointerEvent<HTMLDivElement>, canDoubleClick: boolean): void => {
    if (gesture.current === 'move') {
      window.snip.pin.dragEnd()
      gesture.current = 'idle'
      if (!canDoubleClick || moved.current) {
        lastTap.current = null
        return
      }
      const now = performance.now()
      const previous = lastTap.current
      const isDouble =
        previous !== null &&
        now - previous.time <= DOUBLE_CLICK_MS &&
        Math.abs(event.screenX - previous.x) <= DOUBLE_CLICK_SLOP &&
        Math.abs(event.screenY - previous.y) <= DOUBLE_CLICK_SLOP
      if (isDouble) {
        lastTap.current = null
        closePin('double-click')
        return
      }
      lastTap.current = { time: now, x: event.screenX, y: event.screenY }
      return
    }
    if (gesture.current === 'resize') {
      window.snip.pin.resizeEnd()
      gesture.current = 'idle'
      lastTap.current = null
    }
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    finishGesture(event, true)
  }

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>): void => {
    finishGesture(event, false)
  }

  const onHandlePointerDown = (direction: PinResizeDirection) => {
    return (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0 || gesture.current !== 'idle') return
      event.preventDefault()
      event.stopPropagation()
      gesture.current = 'resize'
      moved.current = false
      startPoint.current = { x: event.screenX, y: event.screenY }
      lastTap.current = null
      capturePointer(event.currentTarget, event.pointerId)
      window.snip.pin.resizeStart(direction, event.screenX, event.screenY)
    }
  }

  return (
    <div
      ref={rootRef}
      className="pin-root"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onContextMenu={(event) => event.preventDefault()}
    >
      {imageUrl ? (
        <img
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
            window.snip.pin.ready()
          }}
          onError={() => closePin('image-error')}
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
      <div className="pin-bar" aria-hidden="true">
        <span className="pin-tag">PIN</span>
        {meta ? (
          <span className="pin-dims">
            {meta.imageWidth} × {meta.imageHeight}
          </span>
        ) : null}
        <span className="pin-zoom">{Math.round(view.zoom * 100)}%</span>
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
