import { Menu, Tray, nativeImage } from 'electron'
import { appState } from './appState'
import { openMainWindow, requestOpenSettings } from './homeWindow'
import { trayIconPath } from './screenshot'

export interface TrayActions {
  startCapture(): void
  pinCount(): number
  closeAllPins(): void
  quit(): void
}

let tray: Tray | null = null
let actions: TrayActions | null = null
let hintShown = false

function trayMenu(state: TrayActions): Menu {
  const count = state.pinCount()
  return Menu.buildFromTemplate([
    { label: `截图  (${appState.hotkey})`, click: () => state.startCapture() },
    { label: '打开主界面', click: () => openMainWindow() },
    { label: '设置快捷键…', click: () => requestOpenSettings() },
    { type: 'separator' },
    {
      label: count > 0 ? `关闭所有贴图 (${count})` : '关闭所有贴图',
      enabled: count > 0,
      click: () => state.closeAllPins(),
    },
    { type: 'separator' },
    { label: '退出', click: () => state.quit() },
  ])
}

export function refreshTray(): void {
  if (!tray || !actions) return
  tray.setContextMenu(trayMenu(actions))
  const error = appState.hotkeyError ?? appState.pinHotkeyError
  tray.setToolTip(
    error
      ? `snip-ocr · ${error}\n退出请使用托盘右键菜单`
      : `snip-ocr · ${appState.hotkey} 截图\n退出请使用托盘右键菜单`,
  )
}

export function createTray(next: TrayActions): void {
  actions = next
  const image = nativeImage.createFromPath(trayIconPath())
  if (image.isEmpty()) console.error('[snip] tray icon missing at', trayIconPath())
  tray = new Tray(image)
  refreshTray()
  tray.on('click', () => next.startCapture())
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}

/** 无通知权限时退回托盘气泡；返回是否成功展示 */
export function showTrayBalloon(title: string, content: string): boolean {
  if (!tray) return false
  tray.displayBalloon({ title, content })
  return true
}

export function setTrayToolTip(text: string): void {
  tray?.setToolTip(text)
}

export function trayHintSeen(): boolean {
  return hintShown
}

export function setTrayHintSeen(value: boolean): void {
  hintShown = value
}
