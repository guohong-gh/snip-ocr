import { BrowserWindow, app } from 'electron'
import { join } from 'node:path'
import { IPC, type HomeWindowAction } from '@shared/ipc'

export const HOME_TITLE = 'snip-ocr'

let homeWindow: BrowserWindow | null = null
let pageReady = false
let pendingSettings = false
let quitting = false

export function getHomeWindow(): BrowserWindow | null {
  return homeWindow && !homeWindow.isDestroyed() ? homeWindow : null
}

export function isHomeVisible(): boolean {
  const win = getHomeWindow()
  return Boolean(win?.isVisible())
}

export function openMainWindow(options?: { showSettings?: boolean }): BrowserWindow {
  if (options?.showSettings) pendingSettings = true
  const existing = getHomeWindow()
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    if (pendingSettings) sendPendingSettings()
    return existing
  }

  const win = new BrowserWindow({
    title: HOME_TITLE,
    icon: join(app.getAppPath(), 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    width: 680,
    height: 560,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    hasShadow: true,
    skipTaskbar: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  homeWindow = win
  pageReady = false

  win.on('page-title-updated', (event) => {
    event.preventDefault()
  })
  win.on('closed', () => {
    if (homeWindow === win) homeWindow = null
  })
  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    win.hide()
  })
  win.on('ready-to-show', () => {
    win.show()
    win.focus()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('did-finish-load', () => {
    pageReady = false
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const loading = devUrl
    ? win.loadURL(`${devUrl}/index.html`)
    : win.loadFile(join(__dirname, '../renderer/index.html'))
  void loading.catch((error) => {
    console.error('[snip] home window load failed:', error)
  })
  return win
}

export function hideMainWindow(): void {
  getHomeWindow()?.hide()
}

export function homeWindowAction(action: HomeWindowAction): void {
  const win = getHomeWindow()
  if (!win) return
  if (action === 'minimize') win.minimize()
  else win.hide()
}

export function markHomeReady(): void {
  pageReady = true
  sendPendingSettings()
}

export function requestOpenSettings(): void {
  pendingSettings = true
  const win = getHomeWindow()
  if (!win) {
    openMainWindow({ showSettings: true })
    return
  }
  if (!win.isVisible()) {
    win.show()
    win.focus()
  }
  sendPendingSettings()
}

export function setQuitting(value: boolean): void {
  quitting = value
}

export function disposeHome(): void {
  quitting = true
  const win = getHomeWindow()
  if (win) win.destroy()
  homeWindow = null
}

function sendPendingSettings(): void {
  const win = getHomeWindow()
  if (!pendingSettings || !pageReady || !win) return
  pendingSettings = false
  win.webContents.send(IPC.homeOpenSettings)
}
