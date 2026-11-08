import { Notification } from 'electron'
import { appState } from './appState'
import { saveConfig } from './config'
import type { CaptureOutcome } from './screenshot'
import { setTrayHintSeen, setTrayToolTip, showTrayBalloon, trayHintSeen } from './tray'

const SELFTEST = process.argv.includes('--selftest')

export function notify(title: string, body: string): void {
  if (SELFTEST) {
    console.log(`[notify] ${title} ${body}`)
    return
  }
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show()
  else setTrayToolTip(`snip-ocr · ${title} ${body}\n退出请使用托盘右键菜单`)
}

export function describe(outcome: CaptureOutcome): { title: string; body: string } | null {
  switch (outcome.kind) {
    case 'copied':
      return { title: '已复制到剪贴板', body: `${outcome.width} × ${outcome.height} px` }
    case 'saved':
      return { title: '已保存截图', body: `${outcome.width} × ${outcome.height} px` }
    case 'pinned':
      return { title: '已贴图', body: `${outcome.width} × ${outcome.height} px` }
    case 'cancelled':
      return null
  }
}

/** 首次把主窗关到托盘时提示一次，之后不再打扰 */
export function showTrayHintOnce(): void {
  if (trayHintSeen()) return
  setTrayHintSeen(true)
  saveConfig({ trayHintShown: true })
  const title = '已收起到托盘'
  const body = `按 ${appState.hotkey} 随时截图；完全退出请用托盘菜单。`
  if (SELFTEST) {
    console.log(`[notify] ${title} ${body}`)
    return
  }
  if (process.platform === 'win32' && showTrayBalloon(title, body)) return
  notify(title, body)
}
