import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { PinListAction, PinSummary } from '@shared/ipc'
import './pinList.css'

function PinListPanel() {
  const [pins, setPins] = useState<PinSummary[]>([])

  useEffect(() => {
    let alive = true
    void window.snipPinList.list().then((next) => {
      if (alive) setPins(next)
    })
    const off = window.snipPinList.onChanged((next) => setPins(next))
    return () => {
      alive = false
      off()
    }
  }, [])

  const act = (id: number, action: PinListAction): void => {
    void window.snipPinList.action(id, action)
  }

  const hiddenCount = pins.filter((pin) => pin.hidden).length

  return (
    <div className="pin-list-root">
      <header className="pin-list-head">
        <span className="pin-list-title">贴图列表</span>
        <span className="pin-list-count">
          {pins.length} 张{hiddenCount > 0 ? ` · ${hiddenCount} 隐藏` : ''}
        </span>
        <button
          type="button"
          className="pin-list-collapse"
          aria-label="收起贴图列表"
          title="收起"
          onClick={() => window.snipPinList.close()}
        >
          ×
        </button>
      </header>
      <div className="pin-list-body">
        {pins.length === 0 ? (
          <p className="pin-list-empty">还没有贴图 · 截图时点「贴图」</p>
        ) : (
          pins.map((pin) => (
            <article className={`pin-list-item${pin.hidden ? ' is-hidden' : ''}`} key={pin.id} data-pin-id={pin.id}>
              <div className="pin-list-thumb-box">
                {pin.thumbUrl ? (
                  <img className="pin-list-thumb" src={pin.thumbUrl} alt="" />
                ) : (
                  <span className="pin-list-thumb-empty" aria-hidden="true" />
                )}
              </div>
              <div className="pin-list-info">
                <span className="pin-list-dims">
                  {pin.imageWidth} × {pin.imageHeight}
                </span>
                <span className="pin-list-state">
                  {pin.hidden ? '已隐藏' : '显示中'}
                  {pin.alwaysOnTop ? ' · 置顶' : ''}
                </span>
              </div>
              <div className="pin-list-actions">
                <button
                  type="button"
                  className="pin-list-action"
                  disabled={pin.hidden}
                  onClick={() => act(pin.id, 'bringToFront')}
                >
                  贴到最前
                </button>
                <button
                  type="button"
                  className="pin-list-action"
                  onClick={() => act(pin.id, pin.hidden ? 'show' : 'hide')}
                >
                  {pin.hidden ? '恢复' : '隐藏'}
                </button>
              </div>
            </article>
          ))
        )}
      </div>
    </div>
  )
}

const host = document.getElementById('root')
if (!host) throw new Error('#root not found')

createRoot(host).render(
  <StrictMode>
    <PinListPanel />
  </StrictMode>,
)
