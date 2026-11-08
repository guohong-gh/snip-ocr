import { app, nativeImage, screen } from 'electron'
import { DEFAULT_PIN_HOTKEY, IPC } from '@shared/ipc'
import { appState, broadcastState, refreshHistoryState } from './appState'
import { hotkeyRegistry } from './hotkeyRegistry'
import {
  configureDataDirectory,
  loadConfig,
  migrateLegacyData,
  readCustomIconDataUrl,
  useSelftestDataSandbox,
} from './config'
import {
  disposeHome,
  getHomeWindow,
  hideMainWindow,
  homeWindowAction,
  isHomeVisible,
  markHomeReady,
  openMainWindow,
  setHomeHiddenHandler,
  setHomeShownHandler,
  setQuitting,
} from './homeWindow'
import { pinService, registerPinScheme } from './pin'
import { registerIpc } from './ipc/registry'
import {
  listPinHistory,
  onPinHistoryChange,
  readHistoryImage,
} from './pinHistory'
import { screenshotService } from './screenshot'
import { registerOverlayTranslateBridge } from './overlayBridge'
import { createTray, destroyTray, refreshTray, setTrayHintSeen } from './tray'
import { describe, notify, showTrayHintOnce } from './notify'
import { refreshHotkeyState } from './hotkeyState'
import {
  applyHotkey,
  applyIconTheme,
  applyPinHotkey,
  checkUpdate,
  pickCustomIcon,
  readAutostart,
  setAutostart,
} from './settingsActions'

const APP_ID = 'local.snip.ocr'
const SELFTEST = process.argv.includes('--selftest')
const START_HIDDEN = process.argv.includes('--hidden')
const START_SETTINGS = process.argv.includes('--settings')

async function startCapture(): Promise<void> {
  try {
    await screenshotService.startCapture()
  } catch (error) {
    notify('截图失败', error instanceof Error ? error.message : String(error))
  }
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
  const input = await readHistoryImage(latest.id)
  if (!input) {
    notify('贴图失败', '最近一张截图已不存在')
    return
  }
  try {
    await pinService.pinFromHistory(input)
    const size = nativeImage.createFromBuffer(input.buffer).getSize()
    notify('已贴图', `${size.width} × ${size.height} px`)
  } catch (error) {
    notify('贴图失败', error instanceof Error ? error.message : String(error))
  }
}

function boot(): void {
  // Windows 上通知与托盘图标归属需要 AppUserModelID
  app.setAppUserModelId(APP_ID)
  registerOverlayTranslateBridge()
  if (process.platform === 'darwin') app.dock?.hide()

  migrateLegacyData()
  const config = loadConfig()
  // 两个快捷键槽共用同一个注册中心：失败回滚 + 定时重试语义完全一致
  hotkeyRegistry.configure('pin', {
    handler: () => void pinLastCapture(),
    fallback: () => DEFAULT_PIN_HOTKEY,
  })
  hotkeyRegistry.onChange(refreshHotkeyState)
  appState.hotkey = config.hotkey
  const applied = screenshotService.setHotkey(appState.hotkey)
  if (!applied.ok) {
    // 冲突不阻断截图入口，后台按固定间隔重试；目标键取用户原来的配置值
    notify('快捷键不可用', `${applied.error}，可在设置里更换`)
  }

  appState.iconTheme = config.iconTheme
  appState.historyLimit = config.historyLimit
  appState.ocrLanguage = config.ocrLanguage
  appState.customIconUrl = readCustomIconDataUrl()
  void screenshotService.setToolbarTheme(appState.iconTheme, appState.customIconUrl)
  appState.autostart = readAutostart()
  const pinApplied = applyPinHotkey(config.pinHotkey)
  if (!pinApplied.ok) notify('贴图快捷键不可用', `${pinApplied.error}，可在设置里更换`)
  refreshHistoryState()

  void pinService.init()
  createTray({
    startCapture: () => void startCapture(),
    pinCount: () => pinService.count,
    closeAllPins: () => pinService.closeAll(),
    quit: () => app.quit(),
  })
  setTrayHintSeen(config.trayHintShown)
  setHomeHiddenHandler(showTrayHintOnce)
  // 用户关掉占用程序后，回到主窗即可立刻恢复，不必等满一个重试周期
  setHomeShownHandler(() => hotkeyRegistry.retryFailed())
  void screenshotService
    .prewarm()
    .catch((error) => console.error('[snip] overlay prewarm failed:', error))
  pinService.onChange(() => {
    refreshTray()
    broadcastState()
  })
  onPinHistoryChange(() => {
    getHomeWindow()?.webContents.send(IPC.pinHistoryChanged)
    refreshHistoryState()
  })
  screenshotService.onOutcome((outcome) => {
    // 历史可用态由索引变化驱动（onPinHistoryChange），这里只负责结果通知；状态广播交给 onCaptureEnded 一次完成
    const message = describe(outcome)
    if (message) notify(message.title, message.body)
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

  registerIpc({
    settings: {
      applyHotkey,
      applyPinHotkey,
      setAutostart,
      applyIconTheme,
      pickCustomIcon,
      checkUpdate,
    },
    appWindow: {
      startCapture,
      pinLast: pinLastCapture,
      closeAllPins: () => pinService.closeAll(),
      windowAction: (action) => homeWindowAction(action),
      markHomeReady: () => markHomeReady(),
    },
  })

  console.log(`[snip] ready · hotkey=${appState.hotkey} · pinHotkey=${appState.pinHotkey} · displays=${screen.getAllDisplays().length}`)
  if (SELFTEST) {
    // 自检只在 --selftest 时动态加载，不进生产启动关键路径
    void import('./selftest').then(({ runSelftest }) => runSelftest())
    return
  }
  if (!START_HIDDEN) openMainWindow({ showSettings: START_SETTINGS })
}

// 必须在 app ready 之前注册自定义协议（贴图图片走 snip-pin://，dev 的 http 页面也能加载）
registerPinScheme()
// 必须在单实例锁之前改 userData：锁文件与 Chromium 缓存都跟着它走
configureDataDirectory()
// 自检同样要在单实例锁之前切到临时沙箱，避免写真实配置、历史与贴图临时文件
if (SELFTEST) useSelftestDataSandbox()

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
    destroyTray()
  })
  void app.whenReady().then(boot)
}
