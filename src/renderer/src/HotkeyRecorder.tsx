import { useEffect, useState } from 'react'
import { prettyAccelerator, toAccelerator } from './accelerator'

interface Props {
  value: string
  platform: string
  onPick: (accelerator: string) => void
}

export default function HotkeyRecorder({ value, platform, onPick }: Props) {
  const [recording, setRecording] = useState(false)

  useEffect(() => {
    if (!recording) return
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecording(false)
        return
      }
      const next = toAccelerator(event)
      if (!next) return
      setRecording(false)
      onPick(next)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [recording, onPick])

  return (
    <button
      type="button"
      className={`hotkey-box${recording ? ' recording' : ''}`}
      aria-label={recording ? '正在录制快捷键，按 Esc 取消' : '点击录制新的快捷键'}
      onClick={(event) => {
        // 失焦，否则录制时空格/回车会重新触发按钮本身
        event.currentTarget.blur()
        setRecording(true)
      }}
    >
      <span className="hotkey-value">{recording ? '请按下新的快捷键…' : prettyAccelerator(value, platform)}</span>
      <span className="hotkey-hint">{recording ? 'Esc 取消' : '点击录制'}</span>
    </button>
  )
}
