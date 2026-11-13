import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import { getHomeWindow } from './homeWindow'
import { pinService } from './pin'

const PIN_LIST_TITLE = 'snip-pin-list'
const LIST_WIDTH = 244
const LIST_GAP = 10

let listWindow: BrowserWindow | null = null
let expanded = false
let attachedHome: BrowserWindow | null = null
let unsubscribePins: (() => void) | null = null

function listBounds(home: BrowserWindow): Electron.Rectangle {
  const homeBounds = home.getBounds()
  const area = screen.getDisplayMatching(homeBounds).workArea
  const height = Math.min(homeBounds.height, area.height)
  const y = Math.min(Math.max(homeBounds.y, area.y), area.y + area.height - height)
  // 优先贴主窗右侧，放不下改左侧，再不行夹进工作区
  let x = homeBounds.x + homeBounds.width + LIST_GAP
  if (x + LIST_WIDTH > area.x + area.width) {
    x = homeBounds.x - LIST_WIDTH - LIST_GAP
  }
  x = Math.min(Math.max(x, area.x), area.x + area.width - LIST_WIDTH)
  return { x: Math.round(x), y: Math.round(y), width: LIST_WIDTH, height: Math.round(height) }
}

function syncBounds(): void {
  const home = getHomeWindow()
  const win = listWindow
  if (!home || !win || win.isDestroyed()) return
  if (!home.isVisible() || home.isMinimized()) {
    if (win.isVisible()) win.hide()
    return
  }
  win.setBounds(listBounds(home))
  if (expanded && !win.isVisible()) win.showInactive()
}

function attachHome(): void {
  const home = getHomeWindow()
  if (!home || home === attachedHome) return
  attachedHome = home
  home.on('move', syncBounds)
  home.on('resize', syncBounds)
  home.on('show', syncBounds)
  home.on('hide', syncBounds)
  home.on('minimize', syncBounds)
  home.on('restore', syncBounds)
  home.on('closed', () => {
    attachedHome = null
    collapsePinList()
  })
}

function createListWindow(): BrowserWindow | null {
  if (listWindow && !listWindow.isDestroyed()) return listWindow
  const home = getHomeWindow()
  if (!home) return null
  const win = new BrowserWindow({
    title: PIN_LIST_TITLE,
    ...listBounds(home),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  listWindow = win
  win.on('page-title-updated', (event) => {
    event.preventDefault()
  })
  win.on('closed', () => {
    if (listWindow === win) listWindow = null
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.once('ready-to-show', () => {
    if (!expanded || win.isDestroyed()) return
    syncBounds()
    win.showInactive()
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const loading = devUrl
    ? win.loadURL(`${devUrl}/pin-list.html`)
    : win.loadFile(join(__dirname, '../renderer/pin-list.html'))
  void loading.catch((error) => console.error('[snip] pin list load failed:', error))
  return win
}

/** 面板可见时推送最新列表；隐藏时不发，展开时由渲染进程主动拉取 */
function pushPins(): void {
  const win = listWindow
  if (!win || win.isDestroyed() || !win.isVisible()) return
  win.webContents.send(IPC.pinListChanged, pinService.list())
}

export function togglePinList(): void {
  if (!getHomeWindow()) return
  attachHome()
  if (expanded) {
    collapsePinList()
    return
  }
  expanded = true
  const win = createListWindow()
  if (!win) {
    expanded = false
    return
  }
  syncBounds()
  if (!win.webContents.isLoading()) win.showInactive()
  pushPins()
}

export function collapsePinList(): void {
  expanded = false
  if (listWindow && !listWindow.isDestroyed() && listWindow.isVisible()) listWindow.hide()
}

export function isPinListExpanded(): boolean {
  return expanded
}

export function getPinListWindow(): BrowserWindow | null {
  return listWindow && !listWindow.isDestroyed() ? listWindow : null
}

/** 启动时接线：贴图实例任何变化（新建/关闭/隐藏/缩略图更新）都刷新面板 */
export function initPinListWindow(): void {
  unsubscribePins ??= pinService.onChange(pushPins)
}

export function disposePinList(): void {
  unsubscribePins?.()
  unsubscribePins = null
  expanded = false
  attachedHome = null
  if (listWindow && !listWindow.isDestroyed()) listWindow.destroy()
  listWindow = null
}
