import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  DEFAULT_HOTKEY,
  DEFAULT_PIN_HOTKEY,
  HISTORY_LIMITS,
  ICON_THEMES,
  type HistoryLimit,
  type IconTheme,
} from '@shared/ipc'

export interface StoredConfig {
  hotkey: string
  pinHotkey: string
  iconTheme: IconTheme
  /** 截图历史保留档位（5/10/50） */
  historyLimit: HistoryLimit
  /** 选定的 OCR 语言标签；空字符串表示跟随系统默认 */
  ocrLanguage: string
  /** 首次关闭到托盘时是否已提示过 */
  trayHintShown: boolean
}

const DEFAULTS: StoredConfig = {
  hotkey: DEFAULT_HOTKEY,
  pinHotkey: DEFAULT_PIN_HOTKEY,
  iconTheme: 'default',
  historyLimit: 10,
  ocrLanguage: '',
  trayHintShown: false,
}

let legacyDataDir: string | null = null

/**
 * 打包态把运行数据放在程序目录的 data/ 下（Portable 放便携 exe 旁边），
 * 这样卸载时随安装目录一起删除，不在 %APPDATA% 留配置、缓存和贴图临时文件。
 */
export function configureDataDirectory(): void {
  if (!app.isPackaged) return
  const base = process.env['PORTABLE_EXECUTABLE_DIR'] ?? dirname(app.getPath('exe'))
  const target = join(base, 'data')
  const current = app.getPath('userData')
  if (resolve(current) === resolve(target)) return
  try {
    mkdirSync(target, { recursive: true })
    // 目录已存在但不可写时 mkdir 不会报错，只有真正写文件才会失败
    const probe = join(target, '.snip-write-probe')
    writeFileSync(probe, '')
    rmSync(probe, { force: true })
    app.setPath('userData', target)
    legacyDataDir = current
    console.log(`[snip] data dir: ${target}`)
  } catch (error) {
    console.error('[snip] data dir 不可写，回退默认 userData:', error)
  }
}

/** 迁移旧版 config.json 后删除整个旧目录；必须在单实例锁之后、loadConfig 之前调用 */
export function migrateLegacyData(): void {
  if (!legacyDataDir) return
  const legacy = legacyDataDir
  legacyDataDir = null
  const target = app.getPath('userData')
  try {
    const src = join(legacy, 'config.json')
    const dst = join(target, 'config.json')
    if (!existsSync(dst) && existsSync(src)) copyFileSync(src, dst)
  } catch (error) {
    console.error('[snip] 旧配置迁移失败:', error)
  }
  try {
    rmSync(legacy, { recursive: true, force: true })
  } catch (error) {
    console.error('[snip] 清理旧数据目录失败:', error)
  }
}

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

function normalize(raw: unknown): StoredConfig {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULTS }
  const source = raw as Record<string, unknown>
  const hotkey = source.hotkey
  const pinHotkey = source.pinHotkey
  const iconTheme = source.iconTheme
  const historyLimit = source.historyLimit
  const ocrLanguage = source.ocrLanguage
  return {
    hotkey: typeof hotkey === 'string' && hotkey.trim() ? hotkey.trim() : DEFAULTS.hotkey,
    pinHotkey: typeof pinHotkey === 'string' && pinHotkey.trim() ? pinHotkey.trim() : DEFAULTS.pinHotkey,
    iconTheme:
      typeof iconTheme === 'string' && (ICON_THEMES as readonly string[]).includes(iconTheme)
        ? (iconTheme as IconTheme)
        : DEFAULTS.iconTheme,
    historyLimit:
      typeof historyLimit === 'number' && (HISTORY_LIMITS as readonly number[]).includes(historyLimit)
        ? (historyLimit as HistoryLimit)
        : DEFAULTS.historyLimit,
    ocrLanguage:
      typeof ocrLanguage === 'string' && ocrLanguage.trim() ? ocrLanguage.trim() : DEFAULTS.ocrLanguage,
    trayHintShown: source.trayHintShown === true,
  }
}

export function loadConfig(): StoredConfig {
  try {
    const file = configPath()
    if (!existsSync(file)) return { ...DEFAULTS }
    return normalize(JSON.parse(readFileSync(file, 'utf-8')))
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveConfig(patch: Partial<StoredConfig>): StoredConfig {
  const next = { ...loadConfig(), ...patch }
  const file = configPath()
  mkdirSync(dirname(file), { recursive: true })
  // 先写临时文件再改名，避免写入中断留下半个 json
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8')
  renameSync(tmp, file)
  return next
}

export function customIconPath(): string {
  return join(app.getPath('userData'), 'icons', 'custom.png')
}

export function readCustomIconDataUrl(): string | null {
  try {
    const file = customIconPath()
    if (!existsSync(file)) return null
    return `data:image/png;base64,${readFileSync(file).toString('base64')}`
  } catch {
    return null
  }
}

export function saveCustomIcon(png: Buffer): void {
  const file = customIconPath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, png)
}

