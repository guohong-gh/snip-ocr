import { app, dialog, nativeImage } from 'electron'
import { statSync } from 'node:fs'
import type { IconTheme, SetHotkeyResult } from '@shared/ipc'
import { appState, broadcastState } from './appState'
import { saveConfig, saveCustomIcon } from './config'
import { getHomeWindow } from './homeWindow'
import { hotkeyRegistry } from './hotkeyRegistry'
import { screenshotService } from './screenshot'

export function applyHotkey(next: string): SetHotkeyResult {
  return hotkeyRegistry.apply('capture', next)
}

export function applyPinHotkey(next: string): SetHotkeyResult {
  return hotkeyRegistry.apply('pin', next)
}

export async function applyIconTheme(theme: IconTheme): Promise<SetHotkeyResult> {
  if (theme === 'custom' && !appState.customIconUrl) return { ok: false, error: '请先选择自定义图标' }
  appState.iconTheme = theme
  saveConfig({ iconTheme: theme })
  await screenshotService.setToolbarTheme(theme, appState.customIconUrl)
  broadcastState()
  return { ok: true }
}

export async function pickCustomIcon(): Promise<SetHotkeyResult> {
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
    appState.customIconUrl = `data:image/png;base64,${png.toString('base64')}`
    return applyIconTheme('custom')
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 登录项写入与回读必须使用同一组 path/args，否则读不到刚写入的状态 */
function loginItemOptions(): { path: string; args: string[] } {
  return { path: process.execPath, args: ['--hidden'] }
}

export function readAutostart(): boolean {
  if (!app.isPackaged) return false
  try {
    return app.getLoginItemSettings(loginItemOptions()).openAtLogin
  } catch {
    return false
  }
}

export function setAutostart(enabled: boolean): SetHotkeyResult {
  if (!app.isPackaged) return { ok: false, error: '仅安装版支持开机自启' }
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, ...loginItemOptions() })
    // 写入后按同一组参数回读，开关状态以系统真实值为准
    appState.autostart = readAutostart()
    broadcastState()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

