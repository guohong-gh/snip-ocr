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
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 })
  const [meta, setMeta] = useState<PinMeta | null>(null)

  useEffect(() => {
    const onWheel = (event: WheelEvent): void => {
      // 滚轮只缩放窗口内的图片内容，窗口大小仍由 8 向拖拽调整
      event.preventDefault()
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      const cx = event.clientX - rect.left
      const cy = event.clientY - rect.top
      setView((prev) => {
        const factor = Math.pow(1.1, -event.deltaY / 100)
        const zoom = Math.min(8, Math.max(0.25, prev.zoom * factor))
        if (Math.abs(zoom - prev.zoom) < 0.0001) return prev
        if (zoom <= 1) {
          return {
            zoom,
            x: (rect.width * (1 - zoom)) / 2,
            y: (rect.height * (1 - zoom)) / 2,
          }
        }
        const ratio = zoom / prev.zoom
        return {
          zoom,
          x: cx - (cx - prev.x) * ratio,
          y: cy - (cy - prev.y) * ratio,
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
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
          onDragStart={(event) => event.preventDefault()}
          onLoad={() => window.snip.pin.ready()}
          onError={() => closePin('image-error')}
        />
      ) : null}
      <div className="pin-frame" />
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
