import {
  Menu,
  Notification,
  Tray,
  app,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
} from 'electron'
import { statSync } from 'node:fs'
import {
  DEFAULT_HOTKEY,
  DEFAULT_PIN_HOTKEY,
  ICON_THEMES,
  IPC,
  type HomeWindowAction,
  type IconTheme,
  type SetHotkeyResult,
  type SnipState,
  type UpdateCheckResult,
} from '@shared/ipc'
import {
  configureDataDirectory,
  loadConfig,
  migrateLegacyData,
  readCustomIconDataUrl,
  saveConfig,
  saveCustomIcon,
} from './config'
import {
  disposeHome,
  getHomeWindow,
  hideMainWindow,
  homeWindowAction,
  isHomeVisible,
  markHomeReady,
  openMainWindow,
  requestOpenSettings,
  setQuitting,
} from './homeWindow'
import { pinService, registerPinScheme } from './pin'
import {
  clearPinHistory,
  copyPinHistoryItem,
  deletePinHistory,
  hasPinHistory,
  listPinHistory,
  onPinHistoryChange,
  readPinHistoryInput,
  savePinHistoryItem,
} from './pinHistory'
import { screenshotService, trayIconPath, type CaptureOutcome } from './screenshot'
import { runSelftest } from './selftest'

const APP_ID = 'local.snip.ocr'
const SELFTEST = process.argv.includes('--selftest')
const START_HIDDEN = process.argv.includes('--hidden')
const START_SETTINGS = process.argv.includes('--settings')

let tray: Tray | null = null
let hotkey = DEFAULT_HOTKEY
let hotkeyError: string | null = null
let pinHotkey = DEFAULT_PIN_HOTKEY
let pinHotkeyError: string | null = null
let iconTheme: IconTheme = 'default'
let customIconUrl: string | null = null
let autostart = false
/** 截图历史是否至少有一条（贴图快捷键与首页按钮的可用态都跟着它走） */
let hasHistory = false

function buildState(): SnipState {
  return {
    hotkey,
    hotkeyError,
    pinHotkey,
    pinHotkeyError,
    iconTheme,
    customIconUrl,
    autostart,
    autostartSupported: app.isPackaged,
    pinCount: pinService.count,
    hasHistory,
    version: app.getVersion(),
    platform: process.platform,
    displayCount: screen.getAllDisplays().length,
  }
}

function broadcastState(): void {
  const win = getHomeWindow()
  if (win) win.webContents.send(IPC.stateChanged, buildState())
}

function notify(title: string, body: string): void {
  if (SELFTEST) {
    console.log(`[notify] ${title} ${body}`)
    return
  }
  if (Notification.isSupported()) new Notification({ title, body, silent: true }).show()
  else tray?.setToolTip(`snip-ocr · ${title} ${body}\n退出请使用托盘右键菜单`)
}

function describe(outcome: CaptureOutcome): { title: string; body: string } | null {
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

function trayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: `截图  (${hotkey})`, click: () => void startCapture() },
    { label: '打开主界面', click: () => openMainWindow() },
    { label: '设置快捷键…', click: () => requestOpenSettings() },
    { type: 'separator' },
    {
      label: pinService.count > 0 ? `关闭所有贴图 (${pinService.count})` : '关闭所有贴图',
      enabled: pinService.count > 0,
      click: () => pinService.closeAll(),
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ])
}

function refreshTray(): void {
  if (!tray) return
  tray.setContextMenu(trayMenu())
  const error = hotkeyError ?? pinHotkeyError
  tray.setToolTip(
    error
      ? `snip-ocr · ${error}\n退出请使用托盘右键菜单`
      : `snip-ocr · ${hotkey} 截图\n退出请使用托盘右键菜单`,
  )
}

/** 重新读取历史是否有条目，并广播给主窗（只在启动与删除/清空时调用，避免截图过程中额外重绘） */
function refreshHistoryState(): void {
  void hasPinHistory().then((value) => {
    if (hasHistory === value) return
    hasHistory = value
    broadcastState()
  })
}

async function startCapture(): Promise<void> {
  try {
    await screenshotService.startCapture()
  } catch (error) {
    notify('截图失败', error instanceof Error ? error.message : String(error))
  }
}

function applyHotkey(next: string): SetHotkeyResult {
  const result = screenshotService.setHotkey(next)
  hotkey = screenshotService.currentHotkey ?? DEFAULT_HOTKEY
  hotkeyError = result.error ?? null
  if (result.ok) saveConfig({ hotkey })
  refreshTray()
  broadcastState()
  return result
}

async function pinLastCapture(): Promise<void> {
  if (screenshotService.isCapturing) {
    // 截图进行中不打扰当前会话（保持长图态语义不变）
    console.log('[snip] 截图进行中，忽略贴图快捷键')
    return
  }
  const latest = (await listPinHistory())[0]
  if (!latest) {
    notify('贴图失败', '还没有截图记录，先按截图快捷键截一张')
    return
  }
  const input = await readPinHistoryInput(latest.id)
  if (!input) {
    notify('贴图失败', '最近一张截图已不存在')
    return
  }
  try {
    await pinService.createPin(input, { recordHistory: false })
    const size = nativeImage.createFromBuffer(input.buffer).getSize()
    notify('已贴图', `${size.width} × ${size.height} px`)
  } catch (error) {
    notify('贴图失败', error instanceof Error ? error.message : String(error))
  }
}

function applyPinHotkey(next: string): SetHotkeyResult {
  const target = next.trim() || DEFAULT_PIN_HOTKEY
  if (pinHotkey === target && globalShortcut.isRegistered(target)) return { ok: true }
  const handler = (): void => void pinLastCapture()
  let ok = false
  try {
    ok = globalShortcut.register(target, handler)
  } catch {
    ok = false
  }
  if (!ok) {
    // 失败时不抢占旧键；旧键若已被注销（启动场景），只在它不同于目标键时补注册一次
    if (pinHotkey !== target && !globalShortcut.isRegistered(pinHotkey)) {
      try {
        globalShortcut.register(pinHotkey, handler)
      } catch {
        // 旧键也注册不上时保持未注册，错误提示会如实说明
      }
    }
    pinHotkeyError = `快捷键 ${target} 注册失败，可能已被其它应用占用`
    refreshTray()
    broadcastState()
    return { ok: false, error: pinHotkeyError }
  }
  if (pinHotkey !== target && globalShortcut.isRegistered(pinHotkey)) globalShortcut.unregister(pinHotkey)
  pinHotkey = target
  pinHotkeyError = null
  saveConfig({ pinHotkey: target })
  refreshTray()
  broadcastState()
  return { ok: true }
}

async function applyIconTheme(theme: IconTheme): Promise<SetHotkeyResult> {
  if (theme === 'custom' && !customIconUrl) return { ok: false, error: '请先选择自定义图标' }
  iconTheme = theme
  saveConfig({ iconTheme: theme })
  await screenshotService.setToolbarTheme(theme, customIconUrl)
  broadcastState()
  return { ok: true }
}

async function pickCustomIcon(): Promise<SetHotkeyResult> {
  const win = getHomeWindow()
  const options: Electron.OpenDialogOptions = {
    title: '选择工具栏图标',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  const file = result.filePaths[0]
  if (result.canceled || !file) return { ok: false, error: '未选择图标' }
  try {
    const stat = statSync(file)
    if (stat.size > 5 * 1024 * 1024) return { ok: false, error: '图片过大（最大 5MB）' }
    const image = nativeImage.createFromPath(file)
    if (image.isEmpty()) return { ok: false, error: '无法读取该图片' }
    const size = image.getSize()
    const maxSide = 128
    const ratio = Math.min(1, maxSide / Math.max(size.width, size.height))
    const normalized =
      ratio < 1
        ? image.resize({ width: Math.round(size.width * ratio), height: Math.round(size.height * ratio) })
        : image
    const png = normalized.toPNG()
    saveCustomIcon(png)
    customIconUrl = `data:image/png;base64,${png.toString('base64')}`
    return applyIconTheme('custom')
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function readAutostart(): boolean {
  if (!app.isPackaged) return false
  try {
    return app.getLoginItemSettings().openAtLogin
  } catch {
    return false
  }
}

function setAutostart(enabled: boolean): SetHotkeyResult {
  if (!app.isPackaged) return { ok: false, error: '仅安装版支持开机自启' }
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath, args: ['--hidden'] })
    autostart = readAutostart()
    broadcastState()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function checkUpdate(): Promise<UpdateCheckResult> {
  // 离线应用：不做网络请求，也不伪造版本
  return new Promise((resolve) => {
    setTimeout(() => resolve({ status: 'latest', version: app.getVersion() }), 1200)
  })
}

function createTray(): void {
  const image = nativeImage.createFromPath(trayIconPath())
  if (image.isEmpty()) console.error('[snip] tray icon missing at', trayIconPath())
  tray = new Tray(image)
  refreshTray()
  tray.on('click', () => void startCapture())
}

function boot(): void {
  // Windows 上通知与托盘图标归属需要 AppUserModelID
  app.setAppUserModelId(APP_ID)
  if (process.platform === 'darwin') app.dock?.hide()

  migrateLegacyData()
  const config = loadConfig()
  hotkey = config.hotkey
  const applied = screenshotService.setHotkey(hotkey)
  hotkey = screenshotService.currentHotkey ?? DEFAULT_HOTKEY
  hotkeyError = applied.error ?? null
  if (!applied.ok) notify('快捷键不可用', `${applied.error}，可在设置里更换`)

  iconTheme = config.iconTheme
  customIconUrl = readCustomIconDataUrl()
  void screenshotService.setToolbarTheme(iconTheme, customIconUrl)
  autostart = readAutostart()
  const pinApplied = applyPinHotkey(config.pinHotkey)
  if (!pinApplied.ok) notify('贴图快捷键不可用', `${pinApplied.error}，可在设置里更换`)
  refreshHistoryState()

  void pinService.init()
  createTray()
  void screenshotService
    .prewarm()
    .catch((error) => console.error('[snip] overlay prewarm failed:', error))
  pinService.onChange(() => {
    refreshTray()
    broadcastState()
  })
  onPinHistoryChange(() => {
    getHomeWindow()?.webContents.send(IPC.pinHistoryChanged)
  })
  screenshotService.onOutcome((outcome) => {
    // 成功出口（复制/另存/贴图/长图）都会写一条历史，这里同步可用态
    if (outcome.kind !== 'cancelled') hasHistory = true
    const message = describe(outcome)
    if (message) notify(message.title, message.body)
    broadcastState()
  })

  let homeWasVisible = false
  screenshotService.onBeforeCapture(() => {
    homeWasVisible = isHomeVisible()
    if (homeWasVisible) hideMainWindow()
  })
  screenshotService.onCaptureEnded(() => {
    broadcastState()
    if (!homeWasVisible) return
    homeWasVisible = false
    openMainWindow()
  })

  ipcMain.handle(IPC.getState, () => buildState())
  ipcMain.handle(IPC.setHotkey, (_event, accelerator: unknown) => {
    if (typeof accelerator !== 'string' || !accelerator.trim()) {
      return { ok: false, error: '快捷键不能为空' } satisfies SetHotkeyResult
    }
    return applyHotkey(accelerator)
  })
  ipcMain.handle(IPC.setPinHotkey, (_event, accelerator: unknown) => {
    if (typeof accelerator !== 'string' || !accelerator.trim()) {
      return { ok: false, error: '快捷键不能为空' } satisfies SetHotkeyResult
    }
    return applyPinHotkey(accelerator)
  })
  ipcMain.handle(IPC.setAutostart, (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return { ok: false, error: '参数无效' } satisfies SetHotkeyResult
    return setAutostart(enabled)
  })
  ipcMain.handle(IPC.setIconTheme, async (_event, theme: unknown) => {
    if (typeof theme !== 'string' || !(ICON_THEMES as readonly string[]).includes(theme)) {
      return { ok: false, error: '无效的图标主题' } satisfies SetHotkeyResult
    }
    return applyIconTheme(theme as IconTheme)
  })
  ipcMain.handle(IPC.pickCustomIcon, () => pickCustomIcon())
  ipcMain.handle(IPC.checkUpdate, () => checkUpdate())

  ipcMain.handle(IPC.pinHistoryList, () => listPinHistory())
  ipcMain.handle(IPC.pinHistoryDelete, async (_event, id: unknown) => {
    if (typeof id === 'string' && id) await deletePinHistory(id)
    refreshHistoryState()
    return listPinHistory()
  })
  ipcMain.handle(IPC.pinHistoryClear, async () => {
    await clearPinHistory()
    refreshHistoryState()
    return listPinHistory()
  })
  ipcMain.handle(IPC.pinHistoryCopy, async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return { ok: false, error: '参数无效' } satisfies SetHotkeyResult
    return (await copyPinHistoryItem(id)) satisfies SetHotkeyResult
  })
  ipcMain.handle(IPC.pinHistorySave, async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return { ok: false, error: '参数无效' } satisfies SetHotkeyResult
    return (await savePinHistoryItem(id)) satisfies SetHotkeyResult
  })
  ipcMain.handle(IPC.pinHistoryPin, async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return { ok: false, error: '参数无效' } satisfies SetHotkeyResult
    const input = await readPinHistoryInput(id)
    if (!input) return { ok: false, error: '该贴图历史已不存在' } satisfies SetHotkeyResult
    try {
      await pinService.createPin(input, { recordHistory: false })
      return { ok: true } satisfies SetHotkeyResult
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies SetHotkeyResult
    }
  })

  ipcMain.on(IPC.homeStartCapture, () => void startCapture())
  ipcMain.on(IPC.pinLast, () => void pinLastCapture())
  ipcMain.on(IPC.pinCloseAll, () => pinService.closeAll())
  ipcMain.on(IPC.homeWindowAction, (_event, action: unknown) => {
    if (action === 'close' || action === 'minimize') homeWindowAction(action as HomeWindowAction)
  })
  ipcMain.on(IPC.quitApp, () => app.quit())
  ipcMain.on(IPC.homeReady, () => markHomeReady())

  ipcMain.handle(IPC.pinMeta, (event) => pinService.metaFor(event.sender.id))
  ipcMain.on(IPC.pinReady, (event) => pinService.markReady(event.sender.id))
  ipcMain.on(IPC.pinClose, (event) => pinService.closeFor(event.sender.id))
  ipcMain.on(IPC.pinDragStart, (event, x: unknown, y: unknown) => {
    pinService.dragStart(event.sender.id, x, y)
  })
  ipcMain.on(IPC.pinDragMove, (event, x: unknown, y: unknown) => {
    pinService.dragMove(event.sender.id, x, y)
  })
  ipcMain.on(IPC.pinDragEnd, (event) => pinService.dragEnd(event.sender.id))
  ipcMain.on(IPC.pinResizeStart, (event, direction: unknown, x: unknown, y: unknown) => {
    pinService.resizeStart(event.sender.id, direction, x, y)
  })
  ipcMain.on(IPC.pinResizeMove, (event, x: unknown, y: unknown) => {
    pinService.resizeMove(event.sender.id, x, y)
  })
  ipcMain.on(IPC.pinResizeEnd, (event) => pinService.resizeEnd(event.sender.id))

  console.log(`[snip] ready · hotkey=${hotkey} · pinHotkey=${pinHotkey} · displays=${screen.getAllDisplays().length}`)
  if (SELFTEST) {
    void runSelftest()
    return
  }
  if (!START_HIDDEN) openMainWindow({ showSettings: START_SETTINGS })
}

// 必须在 app ready 之前注册自定义协议（贴图图片走 snip-pin://，dev 的 http 页面也能加载）
registerPinScheme()
// 必须在单实例锁之前改 userData：锁文件与 Chromium 缓存都跟着它走
configureDataDirectory()

if (!app.requestSingleInstanceLock()) {
  console.log('[snip] 已有实例在运行，退出')
  app.quit()
} else {
  app.on('second-instance', () => openMainWindow())
  app.on('window-all-closed', () => {
    // 常驻托盘，不因窗口关闭而退出
  })
  app.on('before-quit', () => {
    setQuitting(true)
    screenshotService.dispose()
    pinService.dispose()
    disposeHome()
    tray?.destroy()
    tray = null
  })
  void app.whenReady().then(boot)
}
