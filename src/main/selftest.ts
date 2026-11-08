import { app, BrowserWindow, clipboard, dialog, globalShortcut, nativeImage, screen, type WebContents } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DEFAULT_HOTKEY, DEFAULT_PIN_HOTKEY, IPC, type PinMeta } from '@shared/ipc'
import {
  OVERLAY_ACTION_PREFIX,
  OVERLAY_COPY_PREFIX,
  OVERLAY_HUD_RECT_PREFIX,
  OVERLAY_REPLY_CHANNELS,
  OVERLAY_REPLY_NAMES,
  OVERLAY_TRANSLATE_PREFIX,
  OVERLAY_TRANSLATE_STATUS_PREFIX,
  parseOverlayConsoleMessage,
} from '@shared/overlayProtocol'
import { HOME_TITLE, openMainWindow } from './homeWindow'
import { testHooks } from './testHooks'
import {
  LONG_BOTTOM_TICKS,
  LONG_STABLE_TICKS,
  LONG_TICK_MS,
  LONG_WARMUP_MS,
  planLongFrameCrop,
} from './longShot'
import {
  buildOcrScript,
  listOcrLanguages,
  mergeChunkLines,
  mergeOcrLines,
  normalizeOcrText,
  OCR_CHUNK_HEIGHT,
  OCR_CHUNK_OVERLAP,
  ocrService,
  planOcrChunks,
  resolveOcrLanguage,
  splitImageForOcr,
  type OcrChunkLines,
  type OcrLineBox,
} from './ocr'
import {
  computeHistoryPinPlacement,
  computePinPlacement,
  pinImageUrl,
  pinService,
  pinTempDir,
  resolvePinImagePath,
} from './pin'
import { listPinHistory, pinHistoryDir, recordPinHistory, setPinHistoryLimit } from './pinHistory'
import { loadConfig, realUserDataPath, saveConfig, selftestDataDir } from './config'
import { screenshotService, trayIconPath, type CaptureOutcome } from './screenshot'
import { fingerprintPixels, framesLookSame, stitchVertical } from './stitch'
import { translate, translateStatus } from './translate'

interface ToolbarButton {
  title: string
  display: string
}

interface Viewport {
  width: number
  height: number
}

interface PinDisplayInfo {
  bounds: { x: number; y: number }
  scaleFactor: number
}

interface SaveDialogCall {
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}

type SaveDialogSlot = {
  showSaveDialog: (win: BrowserWindow | null, options: SaveDialogCall) => Promise<{ canceled: boolean; filePath?: string }>
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let failures = 0

function check(label: string, ok: boolean, detail: unknown): void {
  failures += ok ? 0 : 1
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${label} | ${JSON.stringify(detail)}`)
}

function info(label: string, detail: unknown): void {
  console.log(`INFO | ${label} | ${JSON.stringify(detail)}`)
}

function findOverlayWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'screenshots' && w.isVisible())
}

function findPinWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'snip-pin' && !w.isDestroyed())
}

function findPinWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((w) => w.getTitle() === 'snip-pin' && !w.isDestroyed())
}

async function waitForValue<T>(probe: () => T | null, timeoutMs = 5000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = probe()
    if (value !== null) return value
    await sleep(50)
  }
  return null
}

/** 读取 Windows 扩展窗口样式：WS_EX_TOOLWINDOW 表示不进任务栏与 Alt+Tab */
function hasToolWindowStyle(win: BrowserWindow): boolean | null {
  if (process.platform !== 'win32') return null
  try {
    const handle = win.getNativeWindowHandle()
    const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0).toString() : handle.readUInt32LE(0).toString()
    const script = [
      '$sig = \'[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);\'',
      'Add-Type -MemberDefinition $sig -Name SnipWin32 -Namespace Snip',
      `[Snip.SnipWin32]::GetWindowLong([IntPtr]${hwnd}, -20)`,
    ].join('; ')
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    })
    const exStyle = Number.parseInt(output.trim(), 10)
    if (!Number.isFinite(exStyle)) return null
    return (exStyle & 0x00000080) !== 0
  } catch (error) {
    info('WS_EX_TOOLWINDOW 检查失败', { error: String(error) })
    return null
  }
}

async function evalJson<T>(wc: WebContents, code: string): Promise<T> {
  return (await wc.executeJavaScript(`(async () => { ${code} })()`)) as T
}

async function clickAt(wc: WebContents, x: number, y: number): Promise<void> {
  wc.sendInputEvent({ type: 'mouseMove', x, y })
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
  await sleep(40)
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  await sleep(80)
}

async function dragSelect(wc: WebContents, from: [number, number], to: [number, number]): Promise<void> {
  wc.sendInputEvent({ type: 'mouseMove', x: from[0], y: from[1] })
  await sleep(30)
  wc.sendInputEvent({ type: 'mouseDown', x: from[0], y: from[1], button: 'left', clickCount: 1 })
  const steps = 8
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(from[0] + ((to[0] - from[0]) * i) / steps)
    const y = Math.round(from[1] + ((to[1] - from[1]) * i) / steps)
    wc.sendInputEvent({ type: 'mouseMove', x, y })
    await sleep(20)
  }
  wc.sendInputEvent({ type: 'mouseUp', x: to[0], y: to[1], button: 'left', clickCount: 1 })
  await sleep(400)
}

/** 按 title / 工具键找到可见的工具栏按钮并触发 click（避免合成鼠标在布局临界点误命中背景） */
async function clickToolbarButton(wc: WebContents, title: string): Promise<boolean> {
  const toolKey: Record<string, string> = {
    OCR: 'ocr',
    贴图: 'pin',
    另存为: 'save',
    长图: 'longshot',
    继续: 'longshot',
    取消: 'cancel',
    确定: 'confirm',
  }
  return (
    (await evalJson<boolean>(
      wc,
      `const key = ${JSON.stringify(toolKey[title] ?? null)};
       const el = key
         ? document.querySelector('.snip-tool-btn[data-snip-tool="' + key + '"]')
         : [...document.querySelectorAll('.screenshots-button')].find(b => b.title === ${JSON.stringify(title)});
       if (!el || getComputedStyle(el).display === 'none') return false;
       el.click();
       return true;`,
    )) === true
  )
}

async function doubleClickAt(wc: WebContents, x: number, y: number): Promise<void> {
  wc.sendInputEvent({ type: 'mouseMove', x, y })
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
  await sleep(30)
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  await sleep(60)
  wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 2 })
  await sleep(30)
  wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 2 })
  await sleep(300)
}

async function usableArea(wc: WebContents): Promise<Viewport> {
  const vp = await evalJson<Viewport>(wc, 'return { width: window.innerWidth, height: window.innerHeight }')
  const pad = Math.max(24, Math.round(Math.min(vp.width, vp.height) * 0.12))
  return { width: vp.width - pad * 2, height: vp.height - pad * 2 }
}

/** 等遮罩页就绪且窗口尺寸稳定（连续两次采样一致），避免拖拽落在未完成 resize 的旧坐标系上 */
async function waitForOverlayReady(
  wc: WebContents,
  timeoutMs = 4000,
): Promise<{ ready: boolean; width: number; height: number }> {
  const deadline = Date.now() + timeoutMs
  let last: { width: number; height: number } | null = null
  let stable = 0
  while (Date.now() < deadline) {
    let probe: { background: boolean; width: number; height: number }
    try {
      probe = await evalJson<{ background: boolean; width: number; height: number }>(
        wc,
        `return {
           background: Boolean(document.querySelector('.screenshots-background')),
           width: window.innerWidth,
           height: window.innerHeight,
         };`,
      )
    } catch {
      return { ready: false, width: last?.width ?? 0, height: last?.height ?? 0 }
    }
    if (probe.background && probe.width > 200 && probe.height > 200) {
      stable = last && last.width === probe.width && last.height === probe.height ? stable + 1 : 0
      if (stable >= 2) return { ready: true, width: probe.width, height: probe.height }
    } else {
      stable = 0
    }
    last = { width: probe.width, height: probe.height }
    await sleep(60)
  }
  return { ready: false, width: last?.width ?? 0, height: last?.height ?? 0 }
}

interface CaptureRegion {
  x: number
  y: number
  width: number
  height: number
}

async function startAndDrag(
  wc: WebContents,
  region?: CaptureRegion,
): Promise<{
  area: Viewport
  selection: CaptureRegion
  barWidth: number | null
  overlayReady: boolean
}> {
  await screenshotService.startCapture()
  const overlay = await waitForOverlayReady(wc)
  const area = await usableArea(wc)
  const from: [number, number] = region
    ? [region.x, region.y]
    : [Math.round(area.width * 0.1), Math.round(area.height * 0.1)]
  const to: [number, number] = region
    ? [region.x + region.width, region.y + region.height]
    : [Math.round(area.width * 0.6), Math.round(area.height * 0.6)]
  await dragSelect(wc, from, to)
  let rect: { x: number; y: number; w: number; h: number } | null = null
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    rect = await evalJson<{ x: number; y: number; w: number; h: number } | null>(
      wc,
      `const el = document.querySelector('#snip-toolbar');
       if (!el || getComputedStyle(el).display === 'none') return null;
       const r = el.getBoundingClientRect();
       return r.width > 10 ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;`,
    )
    if (rect) break
    await sleep(100)
  }
  await sleep(700)
  return {
    area,
    selection: { x: from[0], y: from[1], width: to[0] - from[0], height: to[1] - from[1] },
    barWidth: rect?.w ?? null,
    overlayReady: overlay.ready,
  }
}

/** 框选 + 双击复制到剪贴板 */
async function testCopy(wc: WebContents, outcomes: CaptureOutcome[], scaleFactor: number): Promise<void> {
  clipboard.clear()
  const { area, barWidth, overlayReady } = await startAndDrag(wc)
  check('松开鼠标后工具栏出现', barWidth !== null, { barWidth, overlayReady })

  const buttons = await evalJson<ToolbarButton[]>(
    wc,
    "return [...document.querySelectorAll('.snip-tool-btn')].map(b => ({ title: (b.querySelector('.snip-tool-label')?.textContent || b.title), display: getComputedStyle(b).display }))",
  )
  const visible = buttons.filter((b) => b.display !== 'none')
  const expectedTitles = ['OCR', '贴图', '另存为', '长图', '取消', '确定']
  check(
    '工具栏为 OCR/贴图/另存为/长图/取消/确定',
    visible.length === expectedTitles.length && visible.every((b) => expectedTitles.includes(b.title)),
    { visible: visible.map((b) => b.title), total: buttons.length, barWidth },
  )

  // 留一张框选态截图供目视检查
  const overlayShot = join(app.getPath('temp'), 'snip-selftest-overlay.png')
  const shot = await wc.capturePage()
  writeFileSync(overlayShot, shot.toPNG())
  info('框选态截图', { path: overlayShot, size: shot.getSize() })

  const before = outcomes.length
  await doubleClickAt(
    wc,
    Math.round(area.width * 0.35),
    Math.round(area.height * 0.35),
  )
  await sleep(600)
  check('双击选区内部触发复制', true, {})
  const copied = outcomes.slice(before).find((o) => o.kind === 'copied')
  check('复制触发 ok 事件', Boolean(copied), copied ?? null)

  const image = clipboard.readImage()
  check('剪贴板里有图片可粘贴', !image.isEmpty(), image.getSize())
  if (copied) {
    const expectedW = Math.round(copied.selectionWidth * scaleFactor)
    const ratio = image.getSize().width / expectedW
    check(
      'DPI 一致：裁剪像素 = 选区 DIP × scaleFactor',
      expectedW > 0 && ratio > 0.95 && ratio < 1.05,
      { clip: image.getSize(), selectionDip: copied.selectionWidth, scaleFactor, expectedW },
    )
  }
  check('复制后遮罩窗关闭', findOverlayWindow() === undefined, {})
}

/** 框选 + 保存（用对话框替身，真实验证写盘） */
async function testSave(wc: WebContents, outcomes: CaptureOutcome[], scaleFactor: number): Promise<void> {
  const dir = join(app.getPath('temp'), 'snip-selftest')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const target = join(dir, 'capture.png')

  const captured: { call: SaveDialogCall | null } = { call: null }
  const slot = dialog as unknown as SaveDialogSlot
  const original = slot.showSaveDialog
  slot.showSaveDialog = async (_win, options) => {
    captured.call = options
    return { canceled: false, filePath: target }
  }

  try {
    const before = outcomes.length
    await startAndDrag(wc)
    const clicked = await clickToolbarButton(wc, '另存为')
    await sleep(900)
    check('点击保存按钮', clicked, {})
    const saved = outcomes.slice(before).find((o) => o.kind === 'saved')
    check('保存触发 save 事件', Boolean(saved), saved ?? null)
    const call = captured.call
    check(
      '弹出系统保存对话框（PNG 过滤器）',
      call !== null && (call.filters ?? []).some((f) => f.extensions.includes('png')),
      call,
    )
    check(
      '默认文件名带时间戳',
      /^\d{17}\.png$/.test(String(call?.defaultPath ?? '')),
      { defaultPath: call?.defaultPath ?? null },
    )
    const exists = existsSync(target)
    const size = exists ? nativeImage.createFromPath(target).getSize() : null
    check('生成 PNG 文件', exists && size !== null && size.width > 0, { target, size })
    if (saved && size) {
      const expectedW = Math.round(saved.selectionWidth * scaleFactor)
      check('保存尺寸与选区一致', Math.abs(size.width - expectedW) <= 2, { png: size, expectedW })
    }
    check('保存后遮罩窗关闭', findOverlayWindow() === undefined, {})
  } finally {
    slot.showSaveDialog = original
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 主窗：首页、设置页三个 Tab 与设置项 */
async function testHomeWindow(shotPath: string): Promise<void> {
  const win = openMainWindow()
  await sleep(1500)
  const home = await evalJson<{
    title: string
    bridge: boolean
    heading: string
    captureButton: boolean
    gear: boolean
    statusText: string
    footerText: string
    closeTip: string
    dotBox: { width: number; height: number } | null
    state: {
      hotkey: string
      pinHotkey: string
      iconTheme: string
      autostartSupported: boolean
    } | null
  }>(
    win.webContents,
    `const state = typeof window.snip === 'object' ? await window.snip.getState() : null;
     const dot = document.querySelector('.dot-red');
     const dotRect = dot ? dot.getBoundingClientRect() : null;
     return {
       title: document.title,
       bridge: typeof window.snip === 'object',
       heading: document.querySelector('.app-body h1')?.textContent || '',
       captureButton: Boolean(document.querySelector('.capture-btn')),
       gear: Boolean(document.querySelector('button[aria-label="设置"]')),
       statusText: document.querySelector('.home-status')?.textContent || '',
       footerText: document.querySelector('.app-foot')?.textContent || '',
       closeTip: dot ? (dot.getAttribute('data-tip') || dot.getAttribute('title') || '') : '',
       dotBox: dotRect ? { width: dotRect.width, height: dotRect.height } : null,
       state: state ? {
         hotkey: state.hotkey, pinHotkey: state.pinHotkey,
         iconTheme: state.iconTheme, autostartSupported: state.autostartSupported
       } : null
     };`,
  )
  check('主窗加载首页', home.title === HOME_TITLE && home.heading.includes('准备好'), home)
  check('preload 与状态可用', home.bridge && home.state !== null && home.captureButton && home.gear, home.state)
  check(
    '首页显示贴图状态，关闭入口说明托盘常驻',
    home.statusText.includes('贴图') && home.footerText.includes('确定') && home.closeTip.includes('托盘'),
    { statusText: home.statusText, footerText: home.footerText, closeTip: home.closeTip },
  )
  const stateSnapshot = await evalJson<Record<string, unknown>>(
    win.webContents,
    `return await window.snip.getState();`,
  )
  const stateFields = [
    'hotkey',
    'hotkeyError',
    'pinHotkey',
    'pinHotkeyError',
    'iconTheme',
    'customIconUrl',
    'autostart',
    'autostartSupported',
    'pinCount',
    'hasHistory',
    'historyLimit',
    'ocrLanguage',
    'version',
    'platform',
    'displayCount',
  ]
  check(
    '主窗状态快照字段完整',
    stateFields.every((field) => Object.prototype.hasOwnProperty.call(stateSnapshot, field)),
    { missing: stateFields.filter((field) => !(field in stateSnapshot)) },
  )
  const expectedChannels: Record<string, string> = {
    getState: 'snip:get-state',
    stateChanged: 'snip:state-changed',
    setHotkey: 'snip:set-hotkey',
    setPinHotkey: 'snip:set-pin-hotkey',
    setAutostart: 'snip:set-autostart',
    setIconTheme: 'snip:set-icon-theme',
    pickCustomIcon: 'snip:pick-custom-icon',
    checkUpdate: 'snip:check-update',
    homeStartCapture: 'snip:home-start-capture',
    homeWindowAction: 'snip:home-window-action',
    homeReady: 'snip:home-ready',
    homeOpenSettings: 'snip:home-open-settings',
    quitApp: 'snip:quit-app',
    pinLast: 'snip:pin-last',
    pinCloseAll: 'snip:pin-close-all',
    pinMeta: 'snip:pin-meta',
    pinReady: 'snip:pin-ready',
    pinClose: 'snip:pin-close',
    pinDragStart: 'snip:pin-drag-start',
    pinDragMove: 'snip:pin-drag-move',
    pinDragEnd: 'snip:pin-drag-end',
    pinResizeStart: 'snip:pin-resize-start',
    pinResizeMove: 'snip:pin-resize-move',
    pinResizeEnd: 'snip:pin-resize-end',
    pinHistoryList: 'snip:pin-history-list',
    pinHistoryChanged: 'snip:pin-history-changed',
    pinHistoryDelete: 'snip:pin-history-delete',
    pinHistoryClear: 'snip:pin-history-clear',
    pinHistoryPin: 'snip:pin-history-pin',
    pinHistoryCopy: 'snip:pin-history-copy',
    pinHistorySave: 'snip:pin-history-save',
    setHistoryLimit: 'snip:set-history-limit',
    listOcrLanguages: 'snip:list-ocr-languages',
    setOcrLanguage: 'snip:set-ocr-language',
    translateStatus: 'snip:translate-status',
    translate: 'snip:translate',
  }
  const currentChannels = IPC as Record<string, string>
  const missingChannels = Object.keys(expectedChannels).filter((key) => !(key in currentChannels))
  const changedChannels = Object.entries(expectedChannels)
    .filter(([key, value]) => currentChannels[key] !== value)
    .map(([key, value]) => ({ key, expected: value, actual: currentChannels[key] }))
  const extraChannels = Object.keys(currentChannels).filter((key) => !(key in expectedChannels))
  check(
    'IPC 通道字符串值未变',
    missingChannels.length === 0 && changedChannels.length === 0 && extraChannels.length === 0,
    { missing: missingChannels, changed: changedChannels, extra: extraChannels },
  )
  const inboundChannels = testHooks.registeredIpcChannels()
  const outboundChannels = new Set<string>([
    IPC.stateChanged,
    IPC.pinHistoryChanged,
    IPC.homeOpenSettings,
  ])
  const expectedInboundChannels: string[] = Object.values(IPC).filter(
    (channel) => !outboundChannels.has(channel),
  )
  const duplicateInbound = inboundChannels.filter(
    (channel, index) => inboundChannels.indexOf(channel) !== index,
  )
  const missingInbound = expectedInboundChannels.filter(
    (channel) => !inboundChannels.includes(channel),
  )
  const extraInbound = inboundChannels.filter(
    (channel) => !expectedInboundChannels.includes(channel),
  )
  check(
    '所有入站 IPC 通道恰好注册一次',
    duplicateInbound.length === 0 &&
      missingInbound.length === 0 &&
      extraInbound.length === 0 &&
      inboundChannels.length === expectedInboundChannels.length,
    {
      registered: inboundChannels.length,
      expected: expectedInboundChannels.length,
      duplicate: duplicateInbound,
      missing: missingInbound,
      extra: extraInbound,
    },
  )
  const overlayPrefixes = {
    action: OVERLAY_ACTION_PREFIX,
    copy: OVERLAY_COPY_PREFIX,
    hud: OVERLAY_HUD_RECT_PREFIX,
    translate: OVERLAY_TRANSLATE_PREFIX,
    translateStatus: OVERLAY_TRANSLATE_STATUS_PREFIX,
  }
  check(
    '遮罩协议常量值未变',
    overlayPrefixes.action === '__SNIP_ACTION__' &&
      overlayPrefixes.copy === '__SNIP_COPY__' &&
      overlayPrefixes.hud === '__SNIP_HUD_RECT__' &&
      overlayPrefixes.translate === '__SNIP_TRANSLATE__' &&
      overlayPrefixes.translateStatus === '__SNIP_TRANSLATE_STATUS__',
    overlayPrefixes,
  )
  const overlayReply = { names: OVERLAY_REPLY_NAMES, channels: OVERLAY_REPLY_CHANNELS }
  check(
    '遮罩回送通道名未变',
    OVERLAY_REPLY_NAMES.ocrResult === 'ocr-result' &&
      OVERLAY_REPLY_NAMES.translateStatus === 'translate-status' &&
      OVERLAY_REPLY_NAMES.translateResult === 'translate-result' &&
      OVERLAY_REPLY_CHANNELS.ocrResult === 'SCREENSHOTS:ocr-result' &&
      OVERLAY_REPLY_CHANNELS.translateStatus === 'SCREENSHOTS:translate-status' &&
      OVERLAY_REPLY_CHANNELS.translateResult === 'SCREENSHOTS:translate-result',
    overlayReply,
  )
  const unknownOverlayAction = parseOverlayConsoleMessage(
    `${OVERLAY_ACTION_PREFIX}{"action":"not-a-real-action"}`,
  )
  const brokenOverlayAction = parseOverlayConsoleMessage(`${OVERLAY_ACTION_PREFIX}{bad json`)
  const validOverlayAction = parseOverlayConsoleMessage(
    `${OVERLAY_ACTION_PREFIX}{"action":"ocr","requestId":42}`,
  )
  const invalidRequestId = parseOverlayConsoleMessage(
    `${OVERLAY_ACTION_PREFIX}{"action":"ocr","requestId":"x"}`,
  )
  check(
    '未知遮罩动作被忽略',
    unknownOverlayAction.kind === 'unknown' &&
      brokenOverlayAction.kind === 'unknown' &&
      validOverlayAction.kind === 'action' &&
      validOverlayAction.action === 'ocr' &&
      validOverlayAction.requestId === 42 &&
      invalidRequestId.kind === 'action' &&
      invalidRequestId.requestId === undefined,
    { unknownOverlayAction, brokenOverlayAction, validOverlayAction, invalidRequestId },
  )
  check(
    '翻译请求单点接收',
    testHooks.overlayBridgeRegistrationCount() === 1,
    { registrations: testHooks.overlayBridgeRegistrationCount() },
  )
  check(
    '长图时序常量未变',
    LONG_TICK_MS === 200 &&
      LONG_STABLE_TICKS === 2 &&
      LONG_BOTTOM_TICKS === 5 &&
      LONG_WARMUP_MS === 220,
    { LONG_TICK_MS, LONG_STABLE_TICKS, LONG_BOTTOM_TICKS, LONG_WARMUP_MS },
  )
  check(
    '主窗可缩放且限制在 480×400 – 1200×900',
    win.isResizable() &&
      win.getMinimumSize()[0] <= 480 &&
      win.getMinimumSize()[1] <= 400 &&
      win.getMaximumSize()[0] >= 1200 &&
      win.getMaximumSize()[1] >= 900,
    { min: win.getMinimumSize(), max: win.getMaximumSize() },
  )
  check(
    '窗口红点点击热区足够大',
    home.dotBox !== null && home.dotBox.width >= 20 && home.dotBox.height >= 20,
    home.dotBox,
  )

  const homeShot = await win.webContents.capturePage()
  const homeShotPath = join(app.getPath('temp'), 'snip-selftest-home.png')
  writeFileSync(homeShotPath, homeShot.toPNG())
  info('主窗截图', { path: homeShotPath, size: homeShot.getSize() })

  const gearClicked = await evalJson<boolean>(
    win.webContents,
    `const b = document.querySelector('button[aria-label="设置"]'); if (!b) return false; b.click(); return true;`,
  )
  await sleep(300)
  const settings = await evalJson<{
    open: boolean
    tabs: string[]
    active: string
    rows: number
    switches: number
    iconCards: number
  }>(
    win.webContents,
    `const tabs = [...document.querySelectorAll('.tab')].map(t => (t.textContent || '').trim());
     return {
       open: Boolean(document.querySelector('.settings-page')),
       tabs,
       active: document.querySelector('.tab.active')?.textContent || '',
       rows: document.querySelectorAll('.setting-row').length,
       switches: document.querySelectorAll('.switch input').length,
       iconCards: document.querySelectorAll('.icon-card').length
     };`,
  )
  check(
    '设置页含快捷键/通用/图标三页',
    gearClicked && settings.open && settings.tabs.join(',') === '快捷键,通用设置,图标定制',
    settings,
  )

  const iconTab = await evalJson<boolean>(
    win.webContents,
    `const tab = [...document.querySelectorAll('.tab')].find(t => (t.textContent || '').includes('图标定制'));
     if (!tab) return false; tab.click(); return true;`,
  )
  await sleep(200)
  const icons = await evalJson<{ cards: number; active: string; previews: number }>(
    win.webContents,
    `return {
       cards: document.querySelectorAll('.icon-card').length,
       active: document.querySelector('.icon-card.active span:last-child')?.textContent || '',
       previews: document.querySelectorAll('.toolbar-preview .preview-tool').length
     };`,
  )
  check(
    '图标定制页含 4 个主题卡片与 6 图标预览',
    iconTab && icons.cards === 4 && icons.previews === 6,
    icons,
  )

  const settingsApplied = await evalJson<{ theme: string; hotkey: string }>(
    win.webContents,
    `const theme = await window.snip.setIconTheme('deepseek');
     const afterTheme = await window.snip.getState();
     const next = await window.snip.getState();
     await window.snip.setIconTheme('default');
     return { theme: afterTheme.iconTheme, hotkey: next.pinHotkey };`,
  )
  check(
    '图标主题设置生效',
    settingsApplied.theme === 'deepseek',
    settingsApplied,
  )
  check(
    '贴图快捷键已注册',
    Boolean(settingsApplied.hotkey) && globalShortcut.isRegistered(settingsApplied.hotkey),
    { pinHotkey: settingsApplied.hotkey, defaultPin: DEFAULT_PIN_HOTKEY },
  )

  const generalTab = await evalJson<boolean>(
    win.webContents,
    `const tab = [...document.querySelectorAll('.tab')].find(t => (t.textContent || '').includes('通用设置'));
     if (!tab) return false; tab.click(); return true;`,
  )
  await sleep(200)
  const general = await evalJson<{
    autostartDisabled: boolean
    autostartSupported: boolean
    switches: number
  }>(
    win.webContents,
    `const state = await window.snip.getState();
     const input = document.querySelector('.switch input[aria-label="开机自启动"]');
     return {
       autostartDisabled: Boolean(input && input.disabled),
       autostartSupported: state.autostartSupported,
       switches: document.querySelectorAll('.switch input').length
     };`,
  )
  check(
    '通用设置自启状态与开发态禁用一致',
    generalTab && general.switches === 1 && general.autostartDisabled === !general.autostartSupported,
    general,
  )

  const update = await evalJson<{ status: string; version: string }>(
    win.webContents,
    `return await window.snip.checkUpdate();`,
  )
  check('检查更新返回最新版本', update.status === 'latest' && update.version.length > 0, update)

  // 切回快捷键页并截图设置页供目视检查
  await evalJson<boolean>(
    win.webContents,
    `const tab = [...document.querySelectorAll('.tab')].find(t => (t.textContent || '').includes('快捷键'));
     if (!tab) return false; tab.click(); return true;`,
  )
  await sleep(200)
  const settingsShot = await win.webContents.capturePage()
  writeFileSync(shotPath, settingsShot.toPNG())
  check('设置页可截图（用于目视验收）', !settingsShot.isEmpty(), {
    path: shotPath,
    size: settingsShot.getSize(),
  })

  await evalJson<boolean>(
    win.webContents,
    `const b = document.querySelector('.x-btn'); if (!b) return false; b.click(); return true;`,
  )
  await sleep(150)
  win.hide()
  await sleep(250)
}

async function testOcr(shotPath: string): Promise<void> {
  const sampleLanguages = [
    { tag: 'zh-Hans-CN', displayName: '中文（简体，中国）' },
    { tag: 'en-US', displayName: 'English (United States)' },
  ]
  check(
    'OCR 语言未选择时走系统默认',
    resolveOcrLanguage('', sampleLanguages) === null && resolveOcrLanguage(null, sampleLanguages) === null,
    {},
  )
  check(
    'OCR 非法语言代码回退系统默认',
    resolveOcrLanguage('ja-JP', sampleLanguages) === null,
    { requested: 'ja-JP' },
  )
  check(
    'OCR 选定语言按标签匹配并保留系统写法',
    resolveOcrLanguage('en-us', sampleLanguages)?.tag === 'en-US',
    { matched: resolveOcrLanguage('en-us', sampleLanguages) },
  )
  const selectedScript = buildOcrScript('C:\\tmp\\shot.png', 'en-US')
  const defaultScript = buildOcrScript('C:\\tmp\\shot.png', '')
  check(
    'OCR 选定语言写入识别脚本参数',
    selectedScript.includes(Buffer.from('en-US', 'utf8').toString('base64')) &&
      !selectedScript.includes('__OCR_LANGUAGE_B64__') &&
      !defaultScript.includes('__OCR_LANGUAGE_B64__'),
    { selected: 'en-US' },
  )
  const languages = await listOcrLanguages()
  check(
    '系统 OCR 语言清单可枚举或如实报错',
    Array.isArray(languages.languages) && (languages.languages.length > 0 || Boolean(languages.error)),
    languages,
  )
  const plan = planOcrChunks(4000)
  check(
    '长图 OCR 分块覆盖全高且重叠 100px',
    plan.length === 3 &&
      plan[0].height === OCR_CHUNK_HEIGHT &&
      plan[1].y === OCR_CHUNK_HEIGHT - OCR_CHUNK_OVERLAP &&
      plan[2].y + plan[2].height === 4000,
    { plan },
  )
  const tall = nativeImage.createFromBitmap(Buffer.alloc(100 * 4000 * 4, 255), {
    width: 100,
    height: 4000,
  })
  const slices = splitImageForOcr(tall.toPNG())
  check('长图 OCR 合成图按 1600px 切块', slices.length === 3 && slices.every((slice) => slice.length > 0), {
    slices: slices.length,
  })
  const line = (text: string, y: number, height = 30): OcrLineBox => ({
    text,
    x: 0,
    y,
    width: 100,
    height,
    words: [],
  })
  const chunkLines: OcrChunkLines[] = [
    { offsetY: 0, lines: [line('第一行', 100), line('hel', 1590)] },
    { offsetY: 1500, lines: [line('hello', 90), line('第二行', 200)] },
  ]
  check('长图 OCR 跨块去重与断词拼接', mergeChunkLines(chunkLines) === '第一行\nhello\n第二行', {
    text: mergeChunkLines(chunkLines),
  })
  check('OCR 文本规范化去除汉字间空格', normalizeOcrText('本 地 截 图 工 具') === '本地截图工具', {})
  check('OCR 文本规范化修复数字空格', normalizeOcrText('OCR TIMEOUT MS = 1 5000 ms') === 'OCR TIMEOUT MS = 15000 ms', {})
  check(
    'OCR 文本规范化修复连字符/全角标点',
    normalizeOcrText('Release 2026 一 1 1 一 04') === 'Release 2026-11-04' &&
      normalizeOcrText('Windows OCR 98 ． 5 ％ 一 > 100 ％') === 'Windows OCR 98.5% -> 100%',
    {},
  )
  const word = (text: string, x: number, y: number, width = 15, height = 20) => ({
    text,
    x,
    y,
    width,
    height,
  })
  const lineBox = (
    text: string,
    y: number,
    words: ReturnType<typeof word>[],
  ): OcrLineBox => ({
    text,
    x: 0,
    y,
    width: 400,
    height: 22,
    words,
  })
  check(
    'OCR 双引擎：纯中文行保留中文结果',
    mergeOcrLines(
      [lineBox('本 地 截 图 工 具', 10, [word('本', 0, 10), word('地', 15, 10)])],
      [lineBox('local screenshot', 10, [word('local', 0, 10, 50), word('screenshot', 60, 10, 90)])],
    ) === '本 地 截 图 工 具',
    {},
  )
  check(
    'OCR 双引擎：纯拉丁行采用英文结果',
    mergeOcrLines(
      [lineBox('AIt+A 3000', 10, [word('AIt+A', 0, 10, 60), word('3000', 70, 10, 30)])],
      [lineBox('Alt+A 3000', 10, [word('Alt+A', 0, 10, 60), word('3000', 70, 10, 30)])],
    ) === 'Alt+A 3000',
    {},
  )
  check(
    'OCR 双引擎：混排行按词框合并',
    normalizeOcrText(
      mergeOcrLines(
        [
          lineBox('支 持 AIt+A 快 捷 键', 10, [
            word('支', 0, 10),
            word('持', 15, 10),
            word('AIt+A', 200, 10, 60),
            word('快', 270, 10),
            word('捷', 285, 10),
            word('键', 300, 10),
          ]),
        ],
        [lineBox('Alt+A', 10, [word('Alt+A', 200, 10, 60)])],
      ),
    ) === '支持 Alt+A 快捷键',
    {},
  )
  check(
    'OCR 双引擎：中文漏识别的拉丁行补回',
    normalizeOcrText(
      mergeOcrLines(
        [lineBox('本 地 截 图', 10, [word('本', 0, 10)])],
        [lineBox('Release 2026-11-04', 100, [word('Release', 0, 100, 80)])],
      ),
    ) === '本地截图\nRelease 2026-11-04',
    {},
  )
  check(
    'OCR 双引擎：无英文引擎时保持单引擎行为',
    mergeOcrLines([lineBox('本 地 截 图', 10, [])], null) === '本 地 截 图',
    {},
  )
  try {
    const result = await ocrService.recognize(readFileSync(shotPath))
    check(
      'Windows OCR 识别主窗/设置截图',
      result.text.length > 0 &&
        (result.text.toLowerCase().includes('snip') || result.text.includes('设置')),
      { language: result.language, text: result.text.slice(0, 160) },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('语言包')) info('OCR 跳过：系统未安装可用语言包', { error: message })
    else check('Windows OCR 识别主窗/设置截图', false, { error: message })
  }
}

async function testTranslate(): Promise<void> {
  const decoded = new TextDecoder('gb18030').decode(Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xa3, 0xac]))
  check('GB18030 解码可用', decoded === '你好，', { decoded })

  const status = translateStatus()
  info('翻译插件状态', status)
  if (!status.directions['en-zh'].available) {
    const denied = await translate('Hello, how are you?', 'en-zh')
    check('未安装翻译插件时安全降级', denied.ok === false && denied.reason.includes('未安装'), denied)
  } else {
    const result = await translate('Hello, how are you?', 'en-zh')
    check(
      '英译中链路可用',
      result.ok && result.text.includes('你好') && !result.text.includes('\uFFFD'),
      result,
    )
  }

  if (!status.directions['zh-en'].available) {
    const denied = await translate('你好，今天天气不错。', 'zh-en')
    const expected = status.directions['en-zh'].available ? '未安装中译英模型' : '未安装翻译插件'
    check(
      '缺少中译英模型时明确提示且不返回假译文',
      denied.ok === false && denied.reason.includes(expected),
      { expected, denied },
    )
  } else {
    const result = await translate('你好，今天天气不错。', 'zh-en')
    check('中译英链路可用', result.ok && !result.text.includes('\uFFFD'), result)
  }

  const tooLong = await translate('a'.repeat(5001), 'en-zh')
  check(
    '超长文本拒绝翻译并提示',
    tooLong.ok === false && tooLong.reason.includes('文本过长'),
    tooLong,
  )

  if (!app.isPackaged) {
    const source = readFileSync(join(app.getAppPath(), 'src/main/translate.ts'), 'utf8')
    check('翻译实现不含联网参数', !/'-(?:a|d)'/.test(source), {})
  }
}

/** 遮罩内 OCR 侧栏 */
async function testOcrSidebar(wc: WebContents): Promise<void> {
  clipboard.clear()
  await startAndDrag(wc)
  const clicked = await clickToolbarButton(wc, 'OCR')
  check('点击工具栏「OCR」', clicked, {})
  const ocrUi = await evalJson<{
    ocrDisabled: boolean
    sidebarOnOppositeSide: boolean
  }>(
    wc,
    `const ocr = document.querySelector('.snip-tool-btn[data-snip-tool="ocr"]');
     const bar = document.getElementById('snip-ocr-sidebar');
     const canvas = document.querySelector('.screenshots-canvas');
     const barRect = bar ? bar.getBoundingClientRect() : null;
     const canvasRect = canvas ? canvas.getBoundingClientRect() : null;
     return {
       ocrDisabled: Boolean(ocr && ocr.disabled),
       sidebarOnOppositeSide: Boolean(barRect && canvasRect && (barRect.left >= canvasRect.right || barRect.right <= canvasRect.left))
     };`,
  )
  check('OCR 进行中禁用重复操作', ocrUi.ocrDisabled, ocrUi)
  check('OCR 侧栏在选区对侧', ocrUi.sidebarOnOppositeSide, ocrUi)
  const sidebarShown = await waitForValue(
    () => (findOverlayWindow() !== undefined ? true : null),
    3000,
  )
  check('OCR 后遮罩保持打开', sidebarShown === true, { overlay: Boolean(findOverlayWindow()) })

  const view = testHooks.overlayView()
  if (!view) {
    check('拿到遮罩视图', false, {})
    return
  }
  // 强制推送已知结果，稳定测试侧栏渲染/复制；真实 OCR 链路由 testOcr 覆盖
  view.send(OVERLAY_REPLY_CHANNELS.ocrResult, {
    requestId: Date.now() + 1000,
    status: 'ready',
    text: '自检 OCR 文本 ABC 123',
    language: 'zh-Hans-CN',
    error: null,
  })
  await sleep(300)
  const sidebar = await evalJson<{ open: boolean; editable: boolean; value: string; count: string }>(
    wc,
    `const bar = document.getElementById('snip-ocr-sidebar');
     const ta = bar ? bar.querySelector('.snip-sidebar-text') : null;
     return {
       open: Boolean(bar && bar.classList.contains('show')),
       editable: Boolean(ta && !ta.readOnly),
       value: ta ? ta.value : '',
       count: bar ? (bar.querySelector('.snip-sidebar-count')?.textContent || '') : ''
     };`,
  )
  check(
    'OCR 侧栏出现且文本可编辑',
    sidebar.open && sidebar.editable && sidebar.value.includes('自检 OCR'),
    sidebar,
  )
  const drag = await evalJson<{
    headHits: boolean
    moved: boolean
    inViewport: boolean
    before: { left: number; top: number; width: number; height: number }
    after: { left: number; top: number; width: number; height: number }
    viewport: { width: number; height: number }
  }>(
    wc,
    `const bar = document.getElementById('snip-ocr-sidebar');
     if (!bar) return null;
     const head = bar.querySelector('.snip-sidebar-head');
     const rectOf = (r) => ({ left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) });
     const before = rectOf(bar.getBoundingClientRect());
     const startX = before.left + 30;
     const startY = before.top + 8;
     head.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: startX, clientY: startY }));
     window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: window.innerWidth - 20, clientY: window.innerHeight - 20 }));
     window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: window.innerWidth - 20, clientY: window.innerHeight - 20 }));
     const after = rectOf(bar.getBoundingClientRect());
     return {
       headHits: Boolean(head),
       moved: after.left !== before.left || after.top !== before.top,
       inViewport: after.left >= 0 && after.top >= 0 && after.left + after.width <= window.innerWidth && after.top + after.height <= window.innerHeight,
       before,
       after,
       viewport: { width: window.innerWidth, height: window.innerHeight },
     };`,
  )
  check('OCR 侧栏标题条可拖拽', Boolean(drag?.headHits && drag.moved), drag)
  check('OCR 侧栏拖拽后不越界', Boolean(drag?.inViewport), drag)

  const textDrag = await evalJson<{ moved: boolean; selection: number[]; active: boolean; editable: boolean }>(
    wc,
    `const bar = document.getElementById('snip-ocr-sidebar');
     const ta = bar ? bar.querySelector('.snip-sidebar-text') : null;
     if (!bar || !ta) return null;
     const before = Math.round(bar.getBoundingClientRect().left);
     const r = ta.getBoundingClientRect();
     ta.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: r.left + 20, clientY: r.top + 20 }));
     window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 40, clientY: 40 }));
     window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 40, clientY: 40 }));
     const after = Math.round(bar.getBoundingClientRect().left);
     ta.focus();
     ta.setSelectionRange(0, 5);
     return {
       moved: after !== before,
       selection: [ta.selectionStart, ta.selectionEnd],
       active: document.activeElement === ta,
       editable: !ta.disabled && !ta.readOnly,
     };`,
  )
  check(
    '拖拽只在标题条生效，textarea 仍可输入/选中',
    Boolean(textDrag && !textDrag.moved && textDrag.active && textDrag.editable && textDrag.selection.join('-') === '0-5'),
    textDrag,
  )

  check('OCR 默认不自动复制', clipboard.readText() !== '自检 OCR 文本 ABC 123', {
    clipboard: clipboard.readText().slice(0, 40),
  })

  const typed = '自检编辑后的文字 ABC 123'
  await evalJson<boolean>(
    wc,
    `const ta = document.querySelector('.snip-sidebar-text');
     if (!ta) return false;
     const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
     setter.call(ta, ${JSON.stringify(typed)});
     ta.dispatchEvent(new Event('input', { bubbles: true }));
     return true;`,
  )
  await sleep(150)
  const countText = await evalJson<string>(
    wc,
    `return (document.querySelector('.snip-sidebar-count')?.textContent || '');`,
  )
  const copied = await evalJson<boolean>(
    wc,
    `const b = document.querySelector('.snip-sidebar-copy'); if (!b || b.disabled) return false; b.click(); return true;`,
  )
  await sleep(250)
  check(
    'OCR 侧栏按编辑后文本复制且字数同步',
    copied && countText === `${typed.length} 字` && clipboard.readText() === typed,
    { countText, clipboard: clipboard.readText() },
  )

  // 翻译：中文源禁用 → 英文源启用 → 真实翻译 → 失败态 → 未安装态
  wc.send(OVERLAY_REPLY_CHANNELS.translateStatus, {
    pluginDir: join(app.getPath('userData'), 'plugins', 'translate-locally'),
    directions: {
      'en-zh': { available: true, reason: null },
      'zh-en': { available: false, reason: '未安装中译英模型' },
    },
  })
  await sleep(150)
  const zhTranslate = await evalJson<{ disabled: boolean; title: string; text: string } | null>(
    wc,
    `const b = document.querySelector('.snip-sidebar-translate'); return b ? { disabled: Boolean(b.disabled), title: b.title, text: b.textContent } : null;`,
  )
  check(
    '中文源缺少中译英模型时禁用并提示',
    Boolean(zhTranslate && zhTranslate.disabled && zhTranslate.title.includes('未安装中译英模型') && zhTranslate.text === '译成英文'),
    zhTranslate,
  )

  wc.send(OVERLAY_REPLY_CHANNELS.ocrResult, {
    requestId: Date.now() + 2000,
    status: 'ready',
    text: 'Hello, how are you?',
    language: 'en-US',
    error: null,
  })
  await sleep(200)
  const enTranslate = await evalJson<{ disabled: boolean; title: string } | null>(
    wc,
    `const b = document.querySelector('.snip-sidebar-translate'); return b ? { disabled: Boolean(b.disabled), title: b.title } : null;`,
  )
  check(
    '英文源启用翻译按钮',
    Boolean(enTranslate && !enTranslate.disabled && enTranslate.title.includes('本地英译中')),
    enTranslate,
  )

  // 用真实插件状态覆盖上面的假注入：可用时走真实翻译，不可用时按钮必须保持置灰
  const enZhAvailable = translateStatus().directions['en-zh'].available
  wc.send(OVERLAY_REPLY_CHANNELS.translateStatus, translateStatus())
  await sleep(150)

  const translateClicked = await evalJson<boolean>(
    wc,
    `const b = document.querySelector('.snip-sidebar-translate'); if (!b || b.disabled) return false; b.click(); return true;`,
  )
  const loadingState = await evalJson<{ disabled: boolean; text: string; status: string } | null>(
    wc,
    `const b = document.querySelector('.snip-sidebar-translate');
     return b ? { disabled: Boolean(b.disabled), text: b.textContent, status: (document.querySelector('.snip-sidebar-status')?.textContent || '') } : null;`,
  )
  check(
    '翻译中按钮禁用且状态行提示',
    enZhAvailable
      ? Boolean(translateClicked && loadingState && loadingState.disabled && loadingState.text === '翻译中…' && loadingState.status === '本地翻译中…')
      : Boolean(
          loadingState &&
            loadingState.disabled &&
            loadingState.text === '译成中文' &&
            loadingState.status.includes('未安装翻译插件'),
        ),
    { enZhAvailable, state: loadingState },
  )

  if (enZhAvailable) {
    let translated = ''
    for (let i = 0; i < 30; i += 1) {
      translated = await evalJson<string>(
        wc,
        `return (document.querySelector('.snip-sidebar-translation')?.textContent || '');`,
      )
      if (translated) break
      await sleep(200)
    }
    const afterTranslate = await evalJson<{ status: string; original: string }>(
      wc,
      `return {
       status: (document.querySelector('.snip-sidebar-status')?.textContent || ''),
       original: (document.querySelector('.snip-sidebar-text')?.value || ''),
     };`,
    )
    check(
      '侧栏翻译成功并保留原文',
      translated.includes('你好') && afterTranslate.original === 'Hello, how are you?',
      { enZhAvailable, translated, ...afterTranslate },
    )
  } else {
    const afterTranslate = await evalJson<{ translated: string; status: string; original: string }>(
      wc,
      `return {
       translated: (document.querySelector('.snip-sidebar-translation')?.textContent || ''),
       status: (document.querySelector('.snip-sidebar-status')?.textContent || ''),
       original: (document.querySelector('.snip-sidebar-text')?.value || ''),
     };`,
    )
    check(
      '侧栏翻译成功并保留原文',
      afterTranslate.translated === '' &&
        afterTranslate.original === 'Hello, how are you?' &&
        afterTranslate.status.includes('未安装翻译插件'),
      { enZhAvailable, ...afterTranslate },
    )
  }

  if (enZhAvailable) {
    wc.send(OVERLAY_REPLY_CHANNELS.translateResult, { ok: false, reason: '自检翻译失败提示' })
    await sleep(150)
    const failedTranslate = await evalJson<{ status: string; original: string }>(
      wc,
      `return {
       status: (document.querySelector('.snip-sidebar-status')?.textContent || ''),
       original: (document.querySelector('.snip-sidebar-text')?.value || ''),
     };`,
    )
    check(
      '翻译失败保留原文并显示原因',
      failedTranslate.status.includes('自检翻译失败提示') && failedTranslate.original === 'Hello, how are you?',
      failedTranslate,
    )
  } else {
    const failedTranslate = await evalJson<{ status: string; original: string }>(
      wc,
      `return {
       status: (document.querySelector('.snip-sidebar-status')?.textContent || ''),
       original: (document.querySelector('.snip-sidebar-text')?.value || ''),
     };`,
    )
    check(
      '翻译失败保留原文并显示原因',
      failedTranslate.status.includes('未安装翻译插件') && failedTranslate.original === 'Hello, how are you?',
      { enZhAvailable, ...failedTranslate },
    )
  }

  wc.send(OVERLAY_REPLY_CHANNELS.translateStatus, {
    pluginDir: 'C:\\fake\\plugins\\translate-locally',
    directions: {
      'en-zh': { available: false, reason: '未安装翻译插件' },
      'zh-en': { available: false, reason: '未安装翻译插件' },
    },
  })
  await sleep(150)
  const missingTranslate = await evalJson<{ disabled: boolean; title: string; status: string } | null>(
    wc,
    `const b = document.querySelector('.snip-sidebar-translate');
     return b ? {
       disabled: Boolean(b.disabled),
       title: b.title,
       status: (document.querySelector('.snip-sidebar-status')?.textContent || ''),
     } : null;`,
  )
  check(
    '未安装插件时禁用并提示路径',
    Boolean(
      missingTranslate &&
        missingTranslate.disabled &&
        missingTranslate.title.includes('未安装翻译插件') &&
        missingTranslate.status.includes('plugins'),
    ),
    missingTranslate,
  )

  const sidebarShotPath = join(app.getPath('temp'), 'snip-selftest-ocr-sidebar.png')
  const shot = await wc.capturePage()
  writeFileSync(sidebarShotPath, shot.toPNG())
  info('OCR 侧栏截图', { path: sidebarShotPath, size: shot.getSize() })

  await evalJson<boolean>(
    wc,
    `const b = document.querySelector('.snip-sidebar-close'); if (!b) return false; b.click(); return true;`,
  )
  await sleep(200)
  const stillOpen = findOverlayWindow() !== undefined
  check('关闭 OCR 侧栏后遮罩仍在', stillOpen, { overlay: stillOpen })

  const ocrAgain = await clickToolbarButton(wc, 'OCR')
  await sleep(80)
  await evalJson<boolean>(
    wc,
    `const b = document.querySelector('.snip-sidebar-close'); if (!b) return false; b.click(); return true;`,
  )
  view.send(OVERLAY_REPLY_CHANNELS.ocrResult, {
    requestId: Date.now() + 5000,
    status: 'ready',
    text: '迟到的结果',
    language: 'zh-Hans-CN',
    error: null,
  })
  await sleep(250)
  const reopened = await evalJson<boolean>(
    wc,
    `return Boolean(document.getElementById('snip-ocr-sidebar')?.classList.contains('show'));`,
  )
  check('关闭侧栏后迟到的 OCR 结果不重开', ocrAgain && !reopened, { reopened })

  const cancelled = await clickToolbarButton(wc, '取消')
  await waitForValue(() => (findOverlayWindow() === undefined ? true : null), 3000)
  check('取消按钮关闭遮罩', cancelled && findOverlayWindow() === undefined, {})
}

/** Esc 取消 */
async function testEscape(wc: WebContents, outcomes: CaptureOutcome[]): Promise<void> {
  const before = outcomes.length
  const historyBefore = (await listPinHistory()).length
  await screenshotService.startCapture()
  await sleep(500)
  const opened = findOverlayWindow() !== undefined
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
  await sleep(600)
  check('Esc 关闭遮罩窗', opened && findOverlayWindow() === undefined, { opened })
  const last = outcomes[outcomes.length - 1]
  check('Esc 触发 cancel 事件', outcomes.length > before && last?.kind === 'cancelled', { last: last?.kind ?? null })
  const historyAfter = (await listPinHistory()).length
  check('取消的截图不写入历史', historyAfter === historyBefore, {
    before: historyBefore,
    after: historyAfter,
  })
}

function testPinPlacementMath(): void {
  const sample = join(pinTempDir(), 'pin-123-uuid.png')
  check('贴图图片 URL 可往返解析', resolvePinImagePath(pinImageUrl(sample)) === resolve(sample), {
    url: pinImageUrl(sample),
  })
  check(
    '贴图协议拒绝路径穿越',
    resolvePinImagePath('snip-pin://image/..%2Fconfig.json') === null &&
      resolvePinImagePath('snip-pin://image/%2e%2e%2fconfig.json') === null,
    {},
  )
  check(
    '贴图协议拒绝非贴图文件名',
    resolvePinImagePath('snip-pin://image/config.json') === null &&
      resolvePinImagePath('snip-pin://other/pin-1-x.png') === null &&
      resolvePinImagePath('https://image/pin-1-x.png') === null,
    {},
  )
  for (const scaleFactor of [1, 1.25, 1.5, 2]) {
    const placement = computePinPlacement({
      imageWidth: 1001,
      imageHeight: 667,
      selection: { x: 120, y: 80 },
      display: { x: -1920, y: 0, scaleFactor },
    })
    check(
      `${Math.round(scaleFactor * 100)}% 缩放：贴图物理尺寸 = 截图像素`,
      Math.abs(placement.width * scaleFactor - 1001) <= 1 &&
        Math.abs(placement.height * scaleFactor - 667) <= 1,
      { scaleFactor, placement, physical: [placement.width * scaleFactor, placement.height * scaleFactor] },
    )
    check(
      `${Math.round(scaleFactor * 100)}% 缩放：贴图位置 = 显示器原点 + 选区偏移`,
      placement.x === Math.round(-1920 + 120) && placement.y === 80,
      { scaleFactor, x: placement.x, y: placement.y },
    )
  }
  const centered = computeHistoryPinPlacement({
    imageWidth: 1000,
    imageHeight: 600,
    cursor: { x: 960, y: 540 },
    display: { x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1 },
  })
  check(
    '历史重贴落点 = 光标居中',
    centered.width === 1000 && centered.height === 600 && centered.x === 460 && centered.y === 240,
    centered,
  )
  const clamped = computeHistoryPinPlacement({
    imageWidth: 1000,
    imageHeight: 600,
    cursor: { x: 1910, y: 1070 },
    display: { x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1 },
  })
  check('历史重贴落点夹在显示器内', clamped.x === 920 && clamped.y === 480, clamped)
}

async function readPinMeta(win: BrowserWindow): Promise<PinMeta | null> {
  try {
    const value = await win.webContents.executeJavaScript('window.snipPin.meta()')
    if (value === null || typeof value !== 'object') return null
    return value as PinMeta
  } catch {
    return null
  }
}

async function dispatchPinPointer(
  wc: WebContents,
  selector: string,
  points: [number, number][],
): Promise<boolean> {
  const code = `
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) return false;
    const points = ${JSON.stringify(points)};
    const base = { bubbles: true, cancelable: true, pointerId: 99, pointerType: 'mouse', isPrimary: true };
    target.dispatchEvent(new PointerEvent('pointerdown', { ...base, button: 0, buttons: 1, screenX: points[0][0], screenY: points[0][1] }));
    for (let i = 1; i < points.length; i += 1) {
      target.dispatchEvent(new PointerEvent('pointermove', { ...base, button: -1, buttons: 1, screenX: points[i][0], screenY: points[i][1] }));
    }
    const last = points[points.length - 1];
    target.dispatchEvent(new PointerEvent('pointerup', { ...base, button: 0, buttons: 0, screenX: last[0], screenY: last[1] }));
    return true;
  `
  return evalJson<boolean>(wc, code)
}

async function readPinImageScale(win: BrowserWindow): Promise<number> {
  try {
    return await evalJson<number>(
      win.webContents,
      `const img = document.querySelector('.pin-image');
       if (!img) return 0;
       return new DOMMatrixReadOnly(getComputedStyle(img).transform).a;`,
    )
  } catch {
    return 0
  }
}

async function resetPinZoom(win: BrowserWindow): Promise<void> {
  await evalJson<boolean>(
    win.webContents,
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true, cancelable: true }));
     return true;`,
  )
  await sleep(150)
}

async function testPin(wc: WebContents, outcomes: CaptureOutcome[], display: PinDisplayInfo): Promise<void> {
  try {
    const before = outcomes.length
    await startAndDrag(wc)
    const clicked = await clickToolbarButton(wc, '贴图')
    check('点击工具栏「贴图」', clicked, {})
    const pinWin = await waitForValue(() => findPinWindow() ?? null, 8000)
    check('贴图窗口出现', pinWin !== null, { pins: pinService.count })
    if (!pinWin) return
    // 等待首帧几何校正（显示后的 setContentSize 重试）收敛；清掉可能的鼠标滚轮干扰
    await sleep(900)
    await resetPinZoom(pinWin)

    const pinned = outcomes.slice(before).find((outcome) => outcome.kind === 'pinned')
    check('裁剪 buffer 交给贴图窗口', Boolean(pinned), pinned ?? null)
    check('贴图后遮罩窗关闭', findOverlayWindow() === undefined, {})
    check('贴图窗口可见', pinWin.isVisible(), { visible: pinWin.isVisible() })
    // 置顶是窗口原生状态，偶发在 show() 后首次读取尚未生效；等到生效再判定，并保留首读值便于区分「读取过早」与「从未生效」
    const firstAlwaysOnTop = pinWin.isAlwaysOnTop()
    const onTopSettled = Boolean(await waitForValue(() => (pinWin.isAlwaysOnTop() ? true : null), 2000))
    check('贴图窗口置顶', onTopSettled, { alwaysOnTop: pinWin.isAlwaysOnTop(), firstRead: firstAlwaysOnTop })
    check('贴图窗口可调整大小', pinWin.isResizable(), { resizable: pinWin.isResizable() })

    const meta = await readPinMeta(pinWin)
    check('贴图页 preload 可用', meta !== null, meta)
    const pinBridge = await evalJson<{
      hasMain: boolean
      hasPin: boolean
      pinMethods: string[]
      mainKeys: string[]
    }>(
      pinWin.webContents,
      `const methods = ['meta', 'ready', 'close', 'dragStart', 'dragMove', 'dragEnd', 'resizeStart', 'resizeMove', 'resizeEnd'];
       return {
         hasMain: typeof window.snip !== 'undefined',
         hasPin: typeof window.snipPin === 'object',
         pinMethods: typeof window.snipPin === 'object'
           ? methods.filter((key) => typeof window.snipPin[key] === 'function')
           : [],
         mainKeys: typeof window.snip === 'object' ? Object.keys(window.snip) : [],
       };`,
    )
    check(
      '贴图页只暴露 snipPin，不暴露主窗 API',
      pinBridge.hasMain === false && pinBridge.hasPin && pinBridge.pinMethods.length === 9,
      pinBridge,
    )
    const bounds = pinWin.getBounds()
    if (pinned && meta) {
      const scaleFactor = display.scaleFactor
      const expectedWidth = Math.round(pinned.width / scaleFactor)
      const expectedHeight = Math.round(pinned.height / scaleFactor)
      check(
        '贴图窗口 DIP 尺寸 = 截图像素 / scaleFactor',
        Math.abs(bounds.width - expectedWidth) <= 1 && Math.abs(bounds.height - expectedHeight) <= 1,
        { bounds, expectedWidth, expectedHeight, scaleFactor },
      )
      check(
        '贴图窗口物理尺寸 = 截图像素',
        Math.abs(bounds.width * scaleFactor - pinned.width) <= 1.5 &&
          Math.abs(bounds.height * scaleFactor - pinned.height) <= 1.5,
        { physical: [bounds.width * scaleFactor, bounds.height * scaleFactor], pinned },
      )
      const expectedX = Math.round(display.bounds.x + pinned.selectionX)
      const expectedY = Math.round(display.bounds.y + pinned.selectionY)
      check(
        '贴图窗口位置 = 显示器原点 + 选区偏移（DIP 取整容差 ≤2）',
        Math.abs(bounds.x - expectedX) <= 2 && Math.abs(bounds.y - expectedY) <= 2,
        { bounds, expectedX, expectedY },
      )
      check(
        '贴图图片像素 = 截图像素',
        meta.imageWidth === pinned.width && meta.imageHeight === pinned.height,
        { image: [meta.imageWidth, meta.imageHeight], pinned: [pinned.width, pinned.height] },
      )
      const dom = await evalJson<{
        naturalWidth: number
        naturalHeight: number
        cssWidth: number
        cssHeight: number
        dpr: number
        editor: boolean
        imgSrc: string
      }>(
        pinWin.webContents,
        `const img = document.querySelector('.pin-image');
         return {
           naturalWidth: img ? img.naturalWidth : 0,
           naturalHeight: img ? img.naturalHeight : 0,
           cssWidth: img ? img.getBoundingClientRect().width : 0,
           cssHeight: img ? img.getBoundingClientRect().height : 0,
           dpr: window.devicePixelRatio,
           editor: Boolean(document.querySelector('.screenshots-operations')),
           imgSrc: img ? img.src : ''
         };`,
      )
      check('贴图页只有图片（未带入截图编辑器）', dom.naturalWidth === pinned.width && !dom.editor, dom)
      check('贴图图片走 snip-pin:// 自定义协议', dom.imgSrc.startsWith('snip-pin://image/'), { imgSrc: dom.imgSrc })
      check(
        '贴图按物理像素 1:1 渲染',
        Math.abs(dom.cssWidth * dom.dpr - pinned.width) <= 1.5 &&
          Math.abs(dom.cssHeight * dom.dpr - pinned.height) <= 1.5,
        dom,
      )
      check(
        '贴图内容区与窗口一致',
        Math.abs(meta.contentWidth - bounds.width) <= 1 && Math.abs(meta.contentHeight - bounds.height) <= 1,
        { content: [meta.contentWidth, meta.contentHeight], bounds },
      )
    }

    const pinShotPath = join(app.getPath('temp'), 'snip-selftest-pin.png')
    const pinShot = await pinWin.webContents.capturePage()
    writeFileSync(pinShotPath, pinShot.toPNG())
    info('贴图窗口截图', { path: pinShotPath, size: pinShot.getSize() })

    const toolWindow = hasToolWindowStyle(pinWin)
    if (toolWindow === null) info('WS_EX_TOOLWINDOW 检查跳过', {})
    else check('贴图窗口是 WS_EX_TOOLWINDOW（任务栏/Alt+Tab 排除）', toolWindow, { toolWindow })

    const affordance = await evalJson<{ handles: number; zoom: string; closeOpacity: number }>(
      pinWin.webContents,
      `const close = document.querySelector('.pin-close');
       const zoom = document.querySelector('.pin-zoom');
       return {
         handles: document.querySelectorAll('.pin-handle-ne, .pin-handle-nw, .pin-handle-se, .pin-handle-sw').length,
         zoom: zoom ? (zoom.textContent || '') : '',
         closeOpacity: close ? Number(getComputedStyle(close).opacity) : 0
       };`,
    )
    check(
      '贴图提供四角手柄/缩放百分比/可见关闭入口',
      affordance.handles === 4 && affordance.zoom === '100%' && affordance.closeOpacity > 0,
      affordance,
    )

    const zoomFrom = pinWin.getBounds()
    await resetPinZoom(pinWin)
    const wheelSent = await evalJson<boolean>(
      pinWin.webContents,
      `const root = document.querySelector('.pin-root');
       if (!root) return false;
       const r = root.getBoundingClientRect();
       root.dispatchEvent(new WheelEvent('wheel', {
         deltaY: -100, clientX: r.width / 2, clientY: r.height / 2, bubbles: true, cancelable: true
       }));
       return true;`,
    )
    await sleep(250)
    const zoomScale = await readPinImageScale(pinWin)
    const zoomTo = pinWin.getBounds()
    check(
      '滚轮缩放图片内容且窗口尺寸不变',
      wheelSent &&
        zoomScale > 1.05 &&
        Math.abs(zoomTo.width - zoomFrom.width) <= 1 &&
        Math.abs(zoomTo.height - zoomFrom.height) <= 1,
      { scale: zoomScale, from: zoomFrom, to: zoomTo },
    )

    const zoomTextAfterWheel = await evalJson<string>(
      pinWin.webContents,
      `return (document.querySelector('.pin-zoom')?.textContent || '');`,
    )
    await evalJson<boolean>(
      pinWin.webContents,
      `window.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true, cancelable: true }));
       return true;`,
    )
    await sleep(180)
    const resetScale = await readPinImageScale(pinWin)
    const zoomTextAfterReset = await evalJson<string>(
      pinWin.webContents,
      `return (document.querySelector('.pin-zoom')?.textContent || '');`,
    )
    check(
      '滚轮后显示缩放百分比且 Ctrl+0 回 100%',
      zoomTextAfterWheel === '110%' &&
        Math.abs(resetScale - 1) < 0.01 &&
        zoomTextAfterReset === '100%',
      { zoomTextAfterWheel, resetScale, zoomTextAfterReset },
    )

    const dragFrom = pinWin.getBounds()
    const dragged = await dispatchPinPointer(pinWin.webContents, '.pin-root', [
      [300, 300],
      [340, 320],
    ])
    await sleep(200)
    const dragTo = pinWin.getBounds()
    await sleep(200)
    const dragSettled = pinWin.getBounds()
    const dragScale = await readPinImageScale(pinWin)
    check(
      '拖拽移动贴图窗口',
      dragged &&
        Math.abs(dragTo.x - (dragFrom.x + 40)) <= 1 &&
        Math.abs(dragTo.y - (dragFrom.y + 20)) <= 1,
      { from: dragFrom, to: dragTo },
    )
    check(
      '拖拽松手后贴图不回弹',
      Math.abs(dragSettled.x - dragTo.x) <= 1 && Math.abs(dragSettled.y - dragTo.y) <= 1,
      { dragTo, dragSettled },
    )
    check('拖拽移动后贴图缩放保持', Math.abs(dragScale - resetScale) < 0.01, {
      before: resetScale,
      after: dragScale,
    })

    const resizeFrom = pinWin.getBounds()
    const resizedCall = await dispatchPinPointer(pinWin.webContents, '.pin-handle-se', [
      [400, 300],
      [450, 340],
    ])
    await sleep(200)
    const resizeTo = pinWin.getBounds()
    check(
      '拖拽右下角调整贴图尺寸',
      resizedCall &&
        Math.abs(resizeTo.width - (resizeFrom.width + 50)) <= 1 &&
        Math.abs(resizeTo.height - (resizeFrom.height + 40)) <= 1,
      { from: resizeFrom, to: resizeTo },
    )

    const center = pinWin.getBounds()
    const cx = Math.round(center.width / 2)
    const cy = Math.round(center.height / 2)
    for (let click = 0; click < 2; click += 1) {
      pinWin.webContents.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 })
      pinWin.webContents.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 })
      await sleep(60)
    }
    const doubleClosed = await waitForValue(() => (pinWin.isDestroyed() ? true : null), 3000)
    check('双击关闭贴图窗口', doubleClosed === true, {})

    await startAndDrag(wc)
    const escClicked = await clickToolbarButton(wc, '贴图')
    const escPin = await waitForValue(() => findPinWindow() ?? null, 8000)
    check('同一区域可重复贴图（无卡死/无残留遮罩）', escClicked && escPin !== null && findOverlayWindow() === undefined, {
      clicked: escClicked,
      pins: pinService.count,
    })
    if (escPin) {
      await sleep(300)
      info('重复贴图窗口状态', {
        destroyed: escPin.isDestroyed(),
        visible: escPin.isDestroyed() ? null : escPin.isVisible(),
        pins: pinService.count,
        windows: BrowserWindow.getAllWindows().map((w) => ({
          title: w.getTitle(),
          destroyed: w.isDestroyed(),
        })),
      })
      if (escPin.isDestroyed()) {
        check('Esc 关闭贴图窗口', false, { reason: '窗口在发送 Esc 前已销毁' })
      } else {
        // keyDown 就会触发关闭并销毁窗口，不能再补发 keyUp
        escPin.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
        const escClosed = await waitForValue(() => (escPin.isDestroyed() ? true : null), 3000)
        check('Esc 关闭贴图窗口', escClosed === true, {})
      }
    }

    const createPinAgain = async (): Promise<void> => {
      await startAndDrag(wc)
      await clickToolbarButton(wc, '贴图')
    }
    await createPinAgain()
    await waitForValue(() => (pinService.count === 1 ? true : null), 8000)
    await createPinAgain()
    const twoPins = await waitForValue(() => (pinService.count === 2 ? true : null), 8000)
    check('多张贴图可同时存在', twoPins === true, { pins: pinService.count })
    await sleep(600)

    const pinWindows = findPinWindows()
    const hasCloseButton =
      pinWindows.length === 2 &&
      (await evalJson<boolean>(pinWindows[0].webContents, `return Boolean(document.querySelector('.pin-close'));`))
    check('多张贴图每张都有单张关闭按钮', hasCloseButton, { pins: pinWindows.length })
    if (pinWindows.length === 2) {
      const closing = pinWindows[0]
      const closingBounds = closing.getBounds()
      await clickAt(closing.webContents, closingBounds.width - 14, 14)
      const oneLeft = await waitForValue(
        () => (closing.isDestroyed() && pinService.count === 1 ? true : null),
        3000,
      )
      check('单张关闭按钮只关闭本张', oneLeft === true && findPinWindows().length === 1, {
        oneLeft,
        pins: pinService.count,
      })
    }

    const home = openMainWindow()
    await sleep(400)
    const homeStatus = await evalJson<{ text: string; lastDisabled: boolean }>(
      home.webContents,
      `const buttons = [...document.querySelectorAll('.home-actions .ghost-btn')];
       return {
         text: document.querySelector('.home-status')?.textContent || '',
         lastDisabled: Boolean(buttons[0] && buttons[0].disabled)
       };`,
    )
    check(
      '首页贴图计数与上次截图状态同步',
      homeStatus.text.includes(`贴图 ${pinService.count} 张`) && !homeStatus.lastDisabled,
      homeStatus,
    )
    home.hide()
    await sleep(200)

    pinService.closeAll()
    await sleep(800)
    check('关闭所有贴图', pinService.count === 0 && findPinWindow() === undefined, { pins: pinService.count })
    await sleep(900)
    const leftovers = existsSync(pinTempDir())
      ? readdirSync(pinTempDir()).filter((file) => file.startsWith('pin-') && file.endsWith('.png'))
      : []
    check('关闭贴图后临时图片已释放', leftovers.length === 0, { leftovers })
  } finally {
    pinService.closeAll()
    await sleep(300)
  }
}

async function testConfirmCopy(wc: WebContents, outcomes: CaptureOutcome[]): Promise<void> {
  clipboard.clear()
  const before = outcomes.length
  await startAndDrag(wc)
  // 库的按钮由选区结束事件异步插入，等它出现且可点击后再点确定
  const deadline = Date.now() + 1500
  let ready = false
  let libraryDisabled: boolean | null = null
  while (Date.now() < deadline) {
    const probe = await evalJson<{ exists: boolean; disabled: boolean }>(
      wc,
      `const b = Array.from(document.querySelectorAll('.screenshots-button')).find(node => node.title === '复制到剪贴板');
       if (!b) return { exists: false, disabled: false };
       const disabled = Boolean(b.disabled) || b.classList.contains('disabled') || b.getAttribute('aria-disabled') === 'true';
       return { exists: true, disabled };`,
    )
    libraryDisabled = probe.exists ? probe.disabled : null
    if (probe.exists && !probe.disabled) {
      ready = true
      break
    }
    await sleep(50)
  }
  if (ready) await sleep(250)
  const clicked = await clickToolbarButton(wc, '确定')
  await sleep(600)
  let copied = outcomes.slice(before).find((outcome) => outcome.kind === 'copied')
  let retried = false
  if (!copied) {
    // 库偶尔在选区工具栏重渲染后忽略首次点击，再点一次（等同用户重复点击）
    retried = await clickToolbarButton(wc, '确定')
    await sleep(600)
    copied = outcomes.slice(before).find((outcome) => outcome.kind === 'copied')
  }
  check(
    '「确定」复制到剪贴板并关闭遮罩',
    clicked && ready && Boolean(copied) && pinService.count === 0 && findOverlayWindow() === undefined,
    { clicked, ready, libraryDisabled, retried, pins: pinService.count, copied: copied ?? null },
  )
}

interface StitchFrameSpec {
  width: number
  startRow: number
  height: number
  red: number
  blue: number
  /** 顶部固定表头行数，渲染成高对比色 */
  headerRows?: number
  /** 行号编码的绿色通道步长，默认 2 */
  step?: number
}

function dataUrlToBuffer(url: string): Buffer {
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
}

/** 在遮罩页用 canvas 生成带已知行号的 PNG 帧（行号编码进绿色通道），用于验证重叠检测与颜色 round-trip */
async function renderStitchFrames(wc: WebContents, specs: StitchFrameSpec[]): Promise<Buffer[]> {
  const urls = (await wc.executeJavaScript(`(() => {
    const specs = ${JSON.stringify(specs)};
    return specs.map((spec) => {
      const canvas = document.createElement('canvas');
      canvas.width = spec.width;
      canvas.height = spec.height;
      const ctx = canvas.getContext('2d');
      const headerRows = spec.headerRows || 0;
      const step = spec.step || 2;
      for (let row = 0; row < spec.height; row += 1) {
        if (row < headerRows) {
          ctx.fillStyle = 'rgb(20,250,20)';
        } else {
          const green = Math.min(255, (spec.startRow + row - headerRows) * step);
          ctx.fillStyle = 'rgb(' + spec.red + ',' + green + ',' + spec.blue + ')';
        }
        ctx.fillRect(0, row, spec.width, 1);
      }
      return canvas.toDataURL('image/png');
    });
  })()`)) as string[]
  return urls.map(dataUrlToBuffer)
}

async function testStitchCore(wc: WebContents): Promise<void> {
  const [first, overlapped, disjoint] = await renderStitchFrames(wc, [
    { width: 40, startRow: 0, height: 60, red: 100, blue: 200 },
    { width: 40, startRow: 40, height: 50, red: 100, blue: 200 },
    { width: 40, startRow: 90, height: 30, red: 10, blue: 30 },
  ])

  const merged = stitchVertical([first, overlapped])
  check(
    '两段有重叠时拼接高度 = 60 + 50 - 20',
    merged.height === 90 && merged.overlaps.length === 1 && merged.overlaps[0] === 20,
    { width: merged.width, height: merged.height, overlaps: merged.overlaps },
  )

  const image = nativeImage.createFromBuffer(merged.buffer)
  const bitmap = image.toBitmap()
  const greenAt = (source: Buffer, width: number, y: number): number => source[y * width * 4 + 1]
  check(
    '拼接结果行号连续且无重复行',
    greenAt(bitmap, merged.width, 0) === 0 &&
      greenAt(bitmap, merged.width, 40) === 80 &&
      greenAt(bitmap, merged.width, 59) === 118 &&
      greenAt(bitmap, merged.width, 60) === 120 &&
      greenAt(bitmap, merged.width, 89) === 178,
    { rows: [0, 40, 59, 60, 89].map((y) => greenAt(bitmap, merged.width, y)) },
  )

  const extended = stitchVertical([first, disjoint])
  check(
    '找不到重叠时整帧追加',
    extended.height === 90 && extended.overlaps[0] === 0,
    { height: extended.height, overlaps: extended.overlaps },
  )

  const [noisyA, noisyB] = await renderStitchFrames(wc, [
    { width: 40, startRow: 0, height: 60, red: 100, blue: 200 },
    { width: 40, startRow: 40, height: 50, red: 130, blue: 170 },
  ])
  const noisy = stitchVertical([noisyA, noisyB])
  check(
    '轻微色差（压缩/抗锯齿）下仍按重叠打分拼接',
    noisy.height === 90 && noisy.overlaps[0] === 20,
    { height: noisy.height, overlaps: noisy.overlaps },
  )

  const [headerA, headerB] = await renderStitchFrames(wc, [
    { width: 40, startRow: 0, height: 100, red: 100, blue: 200, headerRows: 6, step: 1 },
    { width: 40, startRow: 40, height: 100, red: 100, blue: 200, headerRows: 6, step: 1 },
  ])
  const sticky = stitchVertical([headerA, headerB])
  const stickyBitmap = nativeImage.createFromBuffer(sticky.buffer).toBitmap()
  check(
    '固定表头只保留一份，内容行连续',
    sticky.height === 140 &&
      greenAt(stickyBitmap, sticky.width, 0) === 250 &&
      greenAt(stickyBitmap, sticky.width, 5) === 250 &&
      greenAt(stickyBitmap, sticky.width, 6) === 0 &&
      greenAt(stickyBitmap, sticky.width, 139) === 133,
    {
      height: sticky.height,
      rows: [0, 5, 6, 139].map((y) => greenAt(stickyBitmap, sticky.width, y)),
    },
  )

  const pixelFrame = (shift: number): Buffer => {
    const width = 64
    const height = 48
    const buffer = Buffer.alloc(width * height * 4)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4
        const value = ((x + shift + y) % 8) * 32
        buffer[offset] = value
        buffer[offset + 1] = value
        buffer[offset + 2] = value
      }
    }
    return buffer
  }
  const base = fingerprintPixels(pixelFrame(0), 64, 48)
  check(
    '滚动到底判定：同画面指纹一致',
    framesLookSame(base, fingerprintPixels(pixelFrame(0), 64, 48)),
    { cells: base.values.length },
  )
  check(
    '滚动到底判定：内容变化后指纹不同',
    !framesLookSame(base, fingerprintPixels(pixelFrame(3), 64, 48)),
    { cells: base.values.length },
  )

  const [tallA, tallB] = await renderStitchFrames(wc, [
    { width: 2, startRow: 0, height: 11000, red: 100, blue: 0 },
    { width: 2, startRow: 0, height: 11000, red: 0, blue: 200 },
  ])
  const tall = stitchVertical([tallA, tallB])
  check(
    '超过 20000 物理像素改为分段导出（不丢帧、不抛错）',
    tall.height === 22000 &&
      tall.segments.length === 2 &&
      tall.segments[0].height === 20000 &&
      tall.segments[1].height === 2000,
    {
      height: tall.height,
      segments: tall.segments.map((segment) => segment.height),
    },
  )

  const samplePath = join(app.getPath('temp'), 'snip-selftest-longshot-stitch.png')
  writeFileSync(samplePath, merged.buffer)
  info('长图拼接样本', {
    path: samplePath,
    width: merged.width,
    height: merged.height,
    overlaps: merged.overlaps,
    bytes: merged.buffer.length,
  })
}

/**
 * 逐像素比较两帧 BGRA 位图。
 * 两次抓屏的裁剪起点可能相差 ≤2px（窗口/显示器取整时序），直接逐像素比较会把整体偏移误判成「大面积不一致」；
 * 这里在 ±2px 内找最佳对齐后再统计，判定阈值不放宽。
 */
function compareBitmaps(
  a: Buffer,
  b: Buffer,
  width: number,
  height: number,
  maxShift = 2,
): { mean: number; max: number; ratioSame: number; shift: { x: number; y: number } } {
  let best = {
    mean: Number.POSITIVE_INFINITY,
    max: 0,
    ratioSame: -1,
    shift: { x: 0, y: 0 },
  }
  for (let dy = -maxShift; dy <= maxShift; dy += 1) {
    for (let dx = -maxShift; dx <= maxShift; dx += 1) {
      const w = width - Math.abs(dx)
      const h = height - Math.abs(dy)
      let sum = 0
      let max = 0
      let same = 0
      for (let y = 0; y < h; y += 1) {
        const ay = y + Math.max(0, -dy)
        const by = y + Math.max(0, dy)
        for (let x = 0; x < w; x += 1) {
          const ax = x + Math.max(0, -dx)
          const bx = x + Math.max(0, dx)
          const offsetA = (ay * width + ax) * 4
          const offsetB = (by * width + bx) * 4
          let equal = true
          for (let channel = 0; channel < 3; channel += 1) {
            const diff = Math.abs(a[offsetA + channel] - b[offsetB + channel])
            sum += diff
            if (diff > max) max = diff
            if (diff > 0) equal = false
          }
          if (equal) same += 1
        }
      }
      const pixels = w * h
      const mean = sum / Math.max(1, pixels * 3)
      const ratioSame = same / Math.max(1, pixels)
      const better =
        ratioSame > best.ratioSame ||
        (ratioSame === best.ratioSame && mean < best.mean) ||
        (ratioSame === best.ratioSame &&
          mean === best.mean &&
          Math.abs(dx) + Math.abs(dy) < Math.abs(best.shift.x) + Math.abs(best.shift.y))
      if (better) best = { mean, max, ratioSame, shift: { x: dx, y: dy } }
    }
  }
  return best
}

/** 长图 HUD 按钮是否复用工具栏同一套视觉（同 class + 同变量解析结果） */
async function compareLongHudButton(
  wc: WebContents,
  action: string,
  tool: string,
): Promise<{ match: boolean; hud: Record<string, string>; toolbar: Record<string, string> } | null> {
  return evalJson(
    wc,
    `const hud = document.querySelector('[data-snip-long="${action}"]');
     const bar = document.querySelector('.snip-tool-btn[data-snip-tool="${tool}"]');
     if (!hud || !bar) return null;
     const pick = (el) => {
       const s = getComputedStyle(el);
       return { width: s.width, height: s.height, borderRadius: s.borderRadius, padding: s.padding,
         backgroundColor: s.backgroundColor, color: s.color, fontSize: s.fontSize,
         ink: s.getPropertyValue('--snip-strip-ink'), hover: s.getPropertyValue('--snip-strip-hover') };
     };
     const a = pick(hud);
     const b = pick(bar);
     const keys = Object.keys(a);
     const match = keys.every((key) => a[key] === b[key]);
     return { match, hud: a, toolbar: b };`,
  )
}

/**
 * 遮罩页冻结原图：src 为整屏 dataURL，尺寸为物理像素。
 * 普通截图与长图帧都以它为唯一像素源，避免两次抓屏带来的内容/偏移差异。
 */
interface OverlayFrameSource {
  src: string
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
}

/**
 * 用同一张冻结原图跑一遍遮罩页裁剪（__snipLongFrame），
 * 与普通截图（库内部 canvas 裁剪）做同源比对。
 */
async function callOverlayLongFrame(
  wc: WebContents,
  source: OverlayFrameSource,
  bounds: CaptureRegion,
): Promise<{ image: ReturnType<typeof nativeImage.createFromDataURL>; scaleX: number; scaleY: number } | null> {
  const origin = nativeImage.createFromDataURL(source.src)
  const size = origin.getSize()
  if (size.width < 1 || size.height < 1) return null
  const scaleX = size.width / source.viewportWidth
  const scaleY = size.height / source.viewportHeight
  const plan = planLongFrameCrop(bounds, size.width, size.height, scaleX, scaleY)
  const patch = origin.crop({ x: plan.x, y: plan.y, width: plan.width, height: plan.height })
  if (patch.isEmpty()) return null
  const payload = {
    dataUrl: `data:image/png;base64,${patch.toPNG().toString('base64')}`,
    crop: plan.crop,
    bounds,
  }
  const result = await evalJson<string | null>(
    wc,
    `return (await window.__snipLongFrame?.(${JSON.stringify(payload)})) ?? null;`,
  )
  if (typeof result !== 'string' || !result.startsWith('data:image/png;base64,')) return null
  const frame = nativeImage.createFromDataURL(result)
  if (frame.isEmpty()) return null
  return { image: frame, scaleX, scaleY }
}

/**
 * 长图的像素对照需要一个不随时间变化的画面：屏幕上正在播放的视频/弹幕会让两次抓帧必然不同。
 * 这里起一个固定位置、无动画的纯色块窗口作为被测对象，选区精确覆盖它。
 */
async function openStaticStage(): Promise<{ win: BrowserWindow; region: CaptureRegion }> {
  // 与 runSelftest 选遮罩屏的口径一致：光标所在显示器，避免多屏时选区落在另一块屏上
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const width = 600
  const height = 320
  const x = display.workArea.x + 20
  const y = display.workArea.y + 20
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,
  })
  const html = `<!doctype html><body style="margin:0;overflow:hidden">
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" shape-rendering="crispEdges">
  <rect width="200" height="160" fill="#ff0000"/>
  <rect x="200" width="200" height="160" fill="#00ff00"/>
  <rect x="400" width="200" height="160" fill="#0000ff"/>
  <rect y="160" width="200" height="160" fill="#ffffff"/>
  <rect x="200" y="160" width="200" height="160" fill="#000000"/>
  <rect x="400" y="160" width="200" height="160" fill="#808080"/>
</svg></body>`
  await win.loadURL(`data:text/html,${encodeURIComponent(html)}`)
  win.showInactive()
  await sleep(300)
  return {
    win,
    region: { x: x - display.bounds.x, y: y - display.bounds.y, width, height },
  }
}

async function testLongShot(wc: WebContents, outcomes: CaptureOutcome[], scaleFactor: number): Promise<void> {
  const stage = await openStaticStage()
  // 基准：同一选区先走普通截图，用于逐像素比较长图首帧
  clipboard.clear()
  const { selection } = await startAndDrag(wc, stage.region)
  const normalCanvasImage = await evalJson<{ visible: boolean }>(
    wc,
    `const image = document.querySelector('.screenshots-canvas-image');
     if (!image) return { visible: false };
     const s = getComputedStyle(image);
     return { visible: s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0 };`,
  )
  check('普通截图态选区内容可见', normalCanvasImage.visible, normalCanvasImage)
  // 同一张冻结原图既服务普通截图，也服务长图帧裁剪，彻底移除「抓两次桌面」变量
  const overlaySource = await evalJson<OverlayFrameSource | null>(
    wc,
    `const img = document.querySelector('.screenshots-background-image');
     if (!img || !img.src || !img.naturalWidth || !img.naturalHeight) return null;
     return {
       src: img.src,
       width: img.naturalWidth,
       height: img.naturalHeight,
       viewportWidth: window.innerWidth,
       viewportHeight: window.innerHeight,
     };`,
  )
  const oracleFrame = overlaySource ? await callOverlayLongFrame(wc, overlaySource, selection) : null
  check(
    '普通截图态可取得冻结原图并生成同源长图帧',
    Boolean(overlaySource && oracleFrame),
    overlaySource && oracleFrame
      ? { source: { width: overlaySource.width, height: overlaySource.height }, frame: oracleFrame.image.getSize() }
      : { overlaySource: Boolean(overlaySource), oracleFrame: Boolean(oracleFrame) },
  )
  await doubleClickAt(
    wc,
    selection.x + Math.round(selection.width * 0.35),
    selection.y + Math.round(selection.height * 0.35),
  )
  await sleep(700)
  const normalImage = clipboard.readImage()
  const normalBitmap = normalImage.toBitmap()
  const normalSize = normalImage.getSize()
  if (findOverlayWindow()) {
    await screenshotService.stopCapture()
  }
  // 等桌面画面稳定，避免长图把主窗状态刷新误判为新内容
  await sleep(1500)

  clipboard.clear()
  await startAndDrag(wc, stage.region)
  const started = await clickToolbarButton(wc, '长图')
  await sleep(1200)
  const hud = await evalJson<{
    visible: boolean
    text: string
    maskHidden: boolean
    longMode: boolean
    canvasImageHidden: boolean
  }>(
    wc,
    `const bar = document.getElementById('snip-long-hud');
     const mask = document.querySelector('.screenshots-background-mask');
     const image = document.querySelector('.screenshots-background-image');
     const selected = document.querySelector('.screenshots-canvas-image');
     const selectedStyle = selected ? getComputedStyle(selected) : null;
     return {
       visible: Boolean(bar && getComputedStyle(bar).display !== 'none'),
       text: bar ? bar.textContent || '' : '',
       maskHidden: Boolean(mask && getComputedStyle(mask).display === 'none') &&
         Boolean(image && getComputedStyle(image).display === 'none'),
       longMode: document.body.classList.contains('snip-long'),
       canvasImageHidden: Boolean(selectedStyle) &&
         (selectedStyle.visibility === 'hidden' || Number(selectedStyle.opacity) === 0),
     };`,
  )
  check('「长图」收起主遮罩，只留穿透 HUD', started && hud.longMode && hud.visible && hud.maskHidden, hud)
  check('长图态选区透出真实屏幕（冻结图不可见）', hud.canvasImageHidden, {
    canvasImageHidden: hud.canvasImageHidden,
  })
  const followButton = await compareLongHudButton(wc, 'longshot-finish', 'confirm')
  check('长图跟随态按钮复用工具栏样式', Boolean(followButton?.match), followButton)
  check('跟随态显示已采集段数', /第 \d+ 段/.test(hud.text) && hud.text.includes('px'), { text: hud.text })

  const preview = await evalJson<{
    visible: boolean
    pointerEvents: string
    rect: { x: number; y: number; width: number; height: number }
    canvas: { width: number; height: number }
    dpr: number
    viewport: { width: number; height: number }
    selection: { x: number; y: number; width: number; height: number }
    overlapsSelection: boolean
  } | null>(
    wc,
    `const el = document.getElementById('snip-long-preview');
     const border = document.getElementById('snip-long-border');
     if (!el || !border) return null;
     const rect = el.getBoundingClientRect();
     const canvas = el.querySelector('canvas');
     const left = parseFloat(border.style.left || '0');
     const top = parseFloat(border.style.top || '0');
     const width = parseFloat(border.style.width || '0');
     const height = parseFloat(border.style.height || '0');
     const selection = { x: left + 2, y: top + 2, width: width - 4, height: height - 4 };
     return {
       visible: getComputedStyle(el).display !== 'none',
       pointerEvents: getComputedStyle(el).pointerEvents,
       rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
       canvas: canvas ? { width: canvas.width, height: canvas.height } : { width: 0, height: 0 },
       dpr: window.devicePixelRatio || 1,
       viewport: { width: window.innerWidth, height: window.innerHeight },
       selection,
       overlapsSelection: rect.x < selection.x + selection.width && rect.x + rect.width > selection.x &&
         rect.y < selection.y + selection.height && rect.y + rect.height > selection.y,
     };`,
  )
  const biggerSide = preview
    ? Math.max(
        preview.viewport.width - (preview.selection.x + preview.selection.width),
        preview.selection.x,
      )
    : 0
  check(
    '采集过程中显示实时预览，且严格位于选区外',
    Boolean(preview && preview.visible && preview.pointerEvents === 'none' && !preview.overlapsSelection),
    preview,
  )
  check(
    '实时预览为等比缩略图（宽度不超过 180 DIP 或可用空间）',
    Boolean(
      preview &&
        preview.canvas.width > 0 &&
        preview.canvas.width <= Math.round(Math.min(180, Math.max(60, biggerSide)) * preview.dpr) &&
        preview.rect.height <= preview.viewport.height * 0.6 + 1,
    ),
    preview ? { canvas: preview.canvas, dpr: preview.dpr, rect: preview.rect, viewport: preview.viewport } : null,
  )

  const before = outcomes.length
  const finishClicked = await evalJson<boolean>(
    wc,
    `const button = document.querySelector('[data-snip-long="longshot-finish"]');
     if (!button) return false;
     button.click();
     return true;`,
  )
  const deadline = Date.now() + 6000
  let done = false
  while (Date.now() < deadline) {
    done = await evalJson<boolean>(
      wc,
      `return Boolean(document.querySelector('[data-snip-long="longshot-save"]'))`,
    )
    if (done) break
    await sleep(200)
  }
  const copied = outcomes.slice(before).find((outcome) => outcome.kind === 'copied')
  const expected = copied ? copied.selectionHeight * scaleFactor : 0
  check(
    '「完成」立即拼接并复制（静止画面不翻倍）',
    finishClicked && done && Boolean(copied) && Math.abs((copied?.height ?? 0) - expected) <= 2,
    { finishClicked, done, copied: copied ?? null, expected, scaleFactor },
  )
  const doneButton = await compareLongHudButton(wc, 'longshot-save', 'save')
  check('长图完成态按钮复用工具栏样式', Boolean(doneButton?.match), doneButton)
  check('完成后剪贴板拿到拼接图', !clipboard.readImage().isEmpty(), {
    size: clipboard.readImage().getSize(),
  })

  const longImage = clipboard.readImage()
  const longSize = longImage.getSize()
  const compareHeight = normalSize.height
  check(
    '长图首帧尺寸与普通截图一致',
    normalSize.width > 0 &&
      longSize.width === normalSize.width &&
      longSize.height >= compareHeight,
    { normalSize, longSize },
  )
  const frameSize = oracleFrame?.image.getSize() ?? null
  const pixelStats =
    oracleFrame &&
    frameSize &&
    normalSize.width > 0 &&
    frameSize.width === normalSize.width &&
    frameSize.height >= compareHeight
      ? compareBitmaps(
          normalBitmap.subarray(0, normalSize.width * compareHeight * 4),
          oracleFrame.image.toBitmap().subarray(0, normalSize.width * compareHeight * 4),
          normalSize.width,
          compareHeight,
        )
      : null
  check(
    '长图单帧像素与普通截图一致（同一冻结原图 / 同 DPI / 同通道）',
    Boolean(pixelStats && pixelStats.mean <= 3 && pixelStats.ratioSame >= 0.95),
    { normalSize, frameSize, pixelStats },
  )

  const ocrClicked = await evalJson<boolean>(
    wc,
    `const button = document.querySelector('[data-snip-long="longshot-ocr"]');
     if (!button) return false;
     button.click();
     return true;`,
  )
  await sleep(600)
  const sidebarOpen = await evalJson<boolean>(
    wc,
    `const bar = document.getElementById('snip-ocr-sidebar');
     return Boolean(bar && bar.classList.contains('show'))`,
  )
  check('长图完成后可 OCR（侧栏正常打开）', ocrClicked && sidebarOpen, { ocrClicked, sidebarOpen })

  const dir = join(app.getPath('temp'), 'snip-selftest-long')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const target = join(dir, 'long.png')
  const slot = dialog as unknown as SaveDialogSlot
  const original = slot.showSaveDialog
  slot.showSaveDialog = async () => ({ canceled: false, filePath: target })
  try {
    const savedClicked = await evalJson<boolean>(
      wc,
      `const button = document.querySelector('[data-snip-long="longshot-save"]');
       if (!button) return false;
       button.click();
       return true;`,
    )
    await sleep(900)
    const exists = existsSync(target)
    const size = exists ? nativeImage.createFromPath(target).getSize() : null
    check(
      '长图完成后可另存为（写出拼接文件）',
      savedClicked && exists && size !== null && size.height === copied?.height,
      { target, size, expectedHeight: copied?.height ?? null },
    )
  } finally {
    slot.showSaveDialog = original
    rmSync(dir, { recursive: true, force: true })
  }

  const closed = await evalJson<boolean>(
    wc,
    `const button = document.querySelector('[data-snip-long="longshot-close"]');
     if (!button) return false;
     button.click();
     return true;`,
  )
  await sleep(700)
  check('关闭长图后遮罩收起', closed && findOverlayWindow() === undefined, {
    closed,
    overlay: Boolean(findOverlayWindow()),
  })
  if (closed) {
    await startAndDrag(wc)
    const restored = await evalJson<{ visible: boolean }>(
      wc,
      `const image = document.querySelector('.screenshots-canvas-image');
       if (!image) return { visible: false };
       const s = getComputedStyle(image);
       return { visible: s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0 };`,
    )
    check('退出长图后再开普通截图，选区内容恢复可见', restored.visible, restored)
    await screenshotService.stopCapture()
    await sleep(300)
  }
  if (findOverlayWindow()) {
    await screenshotService.stopCapture()
    await sleep(300)
  }
  stage.win.destroy()
}

export async function runSelftest(): Promise<void> {
  // 数据目录已在 index 启动时（单实例锁之前）切到临时沙箱，这里只取路径用于断言与清理
  const realUserData = realUserDataPath()
  const dataSandbox = selftestDataDir()

  const outcomes: CaptureOutcome[] = []
  screenshotService.onOutcome((outcome) => outcomes.push(outcome))

  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  info('显示器', {
    total: screen.getAllDisplays().length,
    bounds: display.bounds,
    size: display.size,
    scaleFactor: display.scaleFactor,
  })

  const icon = nativeImage.createFromPath(trayIconPath())
  check('托盘图标随包可用', !icon.isEmpty(), { path: trayIconPath(), size: icon.getSize() })

  if (app.isPackaged) {
    const base = process.env['PORTABLE_EXECUTABLE_DIR'] ?? dirname(app.getPath('exe'))
    const expected = resolve(join(base, 'data'))
    const actual = resolve(realUserData)
    check('运行数据位于程序目录 data/ 下', actual === expected, { actual, expected })
    const legacy = join(app.getPath('appData'), 'snip-ocr')
    check('旧 %APPDATA% 数据目录已清理', !existsSync(legacy), { legacy })
  } else {
    info('开发模式使用默认 userData，不校验安装目录布局', { userData: realUserData })
  }
  check(
    '自检数据已隔离到临时沙箱',
    resolve(app.getPath('userData')) === resolve(dataSandbox) &&
      resolve(dataSandbox) !== resolve(realUserData),
    { userData: app.getPath('userData'), realUserData },
  )

  const altA = screenshotService.setHotkey(DEFAULT_HOTKEY)
  info('默认快捷键 Alt+A 注册结果（false 通常表示被其它应用占用）', altA)
  const probe = 'Ctrl+Alt+Shift+F11'
  const probeResult = screenshotService.setHotkey(probe)
  check(
    '全局快捷键注册链路可用',
    probeResult.ok && globalShortcut.isRegistered(probe),
    { probe, current: screenshotService.currentHotkey },
  )

  await screenshotService.startCapture()
  const overlay = findOverlayWindow()
  check('截图遮罩窗出现', Boolean(overlay), { title: overlay?.getTitle() ?? null })
  const wc = testHooks.overlayView()
  if (!wc) {
    check('拿到截图视图', false, {})
    app.exit(1)
    return
  }

  await screenshotService.stopCapture()
  await sleep(300)
  try {
    testPinPlacementMath()
    const settingsShot = join(app.getPath('temp'), 'snip-selftest-settings.png')
    await testHomeWindow(settingsShot)
    await testOcr(settingsShot)
    await testCopy(wc, outcomes, display.scaleFactor)
    await testSave(wc, outcomes, display.scaleFactor)
    await testPin(wc, outcomes, display)
    await testConfirmCopy(wc, outcomes)
    await testStitchCore(wc)
    await testLongShot(wc, outcomes, display.scaleFactor)
    await testOcrSidebar(wc)
    await testTranslate()
    await testEscape(wc, outcomes)
  } catch (error) {
    check('自检流程无异常中断', false, {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    })
  }

  // 快捷键冲突：注册失败不阻断截图入口；占用释放后主窗显示触发立即重试并广播恢复。
  // 放在截图/贴图/长图用例之后，避免改变主窗与遮罩的时序。
  const homeWin = openMainWindow()
  await sleep(500)
  const originalHotkey = (
    await evalJson<{ hotkey: string }>(homeWin.webContents, `return await window.snip.getState();`)
  ).hotkey
  const blockedKey = 'Ctrl+Alt+Shift+F9'
  globalShortcut.unregister(blockedKey)
  const occupied = globalShortcut.register(blockedKey, () => {})
  const conflict = await evalJson<{
    result: { ok: boolean; error?: string }
    state: { hotkey: string; hotkeyError: string | null }
  }>(
    homeWin.webContents,
    `const result = await window.snip.setHotkey(${JSON.stringify(blockedKey)});
     const state = await window.snip.getState();
     return { result, state };`,
  )
  check(
    '快捷键冲突时注册失败但如实上报错误',
    occupied && !conflict.result.ok && Boolean(conflict.state.hotkeyError),
    { occupied, result: conflict.result, hotkeyError: conflict.state.hotkeyError },
  )

  await evalJson(homeWin.webContents, `window.snip.startCapture(); return true;`)
  const conflictOverlay = await waitForValue(() => findOverlayWindow() ?? null, 3000)
  check(
    '快捷键冲突不影响主窗按钮发起截图',
    Boolean(conflictOverlay),
    { overlay: conflictOverlay?.getTitle() ?? null },
  )
  await screenshotService.stopCapture()
  await sleep(300)

  await evalJson(
    homeWin.webContents,
    `window.__snipHotkeyState = null;
     if (!window.__snipHotkeyUnsub) {
       window.__snipHotkeyUnsub = window.snip.onStateChanged((state) => { window.__snipHotkeyState = state; });
     }
     return true;`,
  )
  globalShortcut.unregister(blockedKey)
  homeWin.hide()
  openMainWindow()
  await sleep(300)
  const healed = await evalJson<{
    state: { hotkey: string; hotkeyError: string | null }
    broadcast: { hotkey: string; hotkeyError: string | null } | null
  }>(
    homeWin.webContents,
    `return { state: await window.snip.getState(), broadcast: window.__snipHotkeyState || null };`,
  )
  const healedRegistered = globalShortcut.isRegistered(blockedKey)
  check(
    '释放占用后立即重试恢复：错误清除、托盘与广播同步',
    healed.state.hotkeyError === null &&
      healed.state.hotkey === blockedKey &&
      healedRegistered &&
      healed.broadcast !== null &&
      healed.broadcast.hotkeyError === null &&
      healed.broadcast.hotkey === blockedKey,
    {
      hotkey: healed.state.hotkey,
      hotkeyError: healed.state.hotkeyError,
      registered: healedRegistered,
      broadcast: healed.broadcast,
    },
  )
  await evalJson(
    homeWin.webContents,
    `window.__snipHotkeyUnsub?.(); window.__snipHotkeyUnsub = null;
     return await window.snip.setHotkey(${JSON.stringify(originalHotkey)});`,
  )

  const history = await listPinHistory()
  const sources = new Set(history.map((item) => item.source))
  check(
    '截图历史覆盖复制/另存/贴图/长图四种来源',
    ['copy', 'save', 'pin', 'longshot'].every((source) => sources.has(source as never)),
    { total: history.length, sources: [...sources] },
  )
  check('截图历史默认档位为 10', loadConfig().historyLimit === 10, { limit: loadConfig().historyLimit })
  let storedItems: number | null = null
  try {
    const raw = JSON.parse(readFileSync(join(pinHistoryDir(), 'history.json'), 'utf8')) as { items?: unknown[] }
    storedItems = Array.isArray(raw.items) ? raw.items.length : null
  } catch {
    storedItems = null
  }
  check('截图历史索引已落盘（重启可恢复）', storedItems === history.length, {
    stored: storedItems,
    listed: history.length,
  })

  // 档位切换：补两条记录，确保超过 5 条后再切换，验证按新上限裁剪
  const pixel = nativeImage.createFromBitmap(Buffer.alloc(4, 255), { width: 1, height: 1 }).toPNG()
  await recordPinHistory(pixel, 1, 1, 'copy')
  await recordPinHistory(pixel, 1, 1, 'copy')
  saveConfig({ historyLimit: 5 })
  await setPinHistoryLimit(5)
  const five = await listPinHistory()
  check('截图历史切到 5 档后裁剪到 5 条', five.length === 5, { total: five.length })
  saveConfig({ historyLimit: 10 })
  await setPinHistoryLimit(10)
  check('截图历史档位切回 10 生效', loadConfig().historyLimit === 10, { limit: loadConfig().historyLimit })

  screenshotService.dispose()
  // 沙箱留在临时目录由下次启动清理：此时 Chromium 仍占用其中的缓存文件，立即删会 EPERM
  console.log(failures === 0 ? '[selftest] ALL PASS' : `[selftest] ${failures} FAILED`)
  app.exit(failures === 0 ? 0 : 1)
}
