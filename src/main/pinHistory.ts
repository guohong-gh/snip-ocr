import { app, clipboard, dialog, nativeImage } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  HISTORY_SOURCES,
  type HistoryLimit,
  type HistorySource,
  type PinHistoryItem,
  type SetHotkeyResult,
} from '@shared/ipc'
import { loadConfig } from './config'

/** 当前保留档位，动态读取配置，切换后立即生效 */
function historyLimit(): HistoryLimit {
  return loadConfig().historyLimit
}
const INDEX_FILE = 'history.json'
const FILE_PREFIX = 'history-'
/** 缩略图最长边（像素），列表按 64×42 DIP 展示，足够 2x 屏清晰 */
const THUMB_MAX_SIDE = 192

interface StoredPinHistoryItem {
  id: string
  createdAt: number
  width: number
  height: number
  /** 原图文件名，相对 pinHistoryDir() */
  file: string
  /** 缩略图文件名，相对 pinHistoryDir() */
  thumb: string
  /** 截图出口来源；旧索引没有该字段时按贴图处理 */
  source: HistorySource
}

function normalizeSource(value: unknown): HistorySource {
  return (HISTORY_SOURCES as readonly unknown[]).includes(value) ? (value as HistorySource) : 'pin'
}

export function pinHistoryDir(): string {
  return join(app.getPath('userData'), 'pin-history')
}

let loaded: StoredPinHistoryItem[] | null = null
let queue: Promise<unknown> = Promise.resolve()
const changeListeners = new Set<() => void>()

export function onPinHistoryChange(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

/** 串行化读写，避免并发贴图时 history.json 互相覆盖 */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task)
  queue = next.catch(() => undefined)
  return next
}

function isSafeFileName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name === basename(name) &&
    name.startsWith(FILE_PREFIX) &&
    name.endsWith('.png')
  )
}

function isValidItem(value: unknown): value is StoredPinHistoryItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  return (
    typeof item.id === 'string' &&
    typeof item.createdAt === 'number' &&
    Number.isFinite(item.createdAt) &&
    typeof item.width === 'number' &&
    Number.isFinite(item.width) &&
    typeof item.height === 'number' &&
    Number.isFinite(item.height) &&
    isSafeFileName(item.file) &&
    isSafeFileName(item.thumb)
  )
}

async function removeFiles(files: string[]): Promise<void> {
  await Promise.all(
    files.map((file) => unlink(join(pinHistoryDir(), file)).catch(() => undefined)),
  )
}

/** 清理索引未引用的残留文件（写入中断、旧版本遗留），不动索引内的历史 */
async function cleanupOrphans(items: StoredPinHistoryItem[]): Promise<void> {
  const keep = new Set(items.flatMap((item) => [item.file, item.thumb]))
  try {
    const files = await readdir(pinHistoryDir())
    await removeFiles(
      files.filter((file) => file.startsWith(FILE_PREFIX) && file.endsWith('.png') && !keep.has(file)),
    )
  } catch {
    // 目录还不存在时无需清理
  }
}

async function saveIndex(items: StoredPinHistoryItem[]): Promise<void> {
  await mkdir(pinHistoryDir(), { recursive: true })
  const file = join(pinHistoryDir(), INDEX_FILE)
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify({ version: 1, items }, null, 2), 'utf-8')
  await rename(tmp, file)
}

async function ensureLoaded(): Promise<StoredPinHistoryItem[]> {
  if (loaded) return loaded
  const dir = pinHistoryDir()
  let items: StoredPinHistoryItem[] = []
  try {
    const file = join(dir, INDEX_FILE)
    if (existsSync(file)) {
      const raw = JSON.parse(await readFile(file, 'utf-8')) as { items?: unknown }
      if (Array.isArray(raw.items)) {
        items = raw.items.filter(isValidItem).map((item) => ({
          ...item,
          source: normalizeSource((item as { source?: unknown }).source),
        }))
      }
    }
  } catch {
    items = []
  }

  // 原图丢失的记录不再展示；超过上限的旧记录淘汰
  const limit = historyLimit()
  const valid = items.filter((item) => existsSync(join(dir, item.file)))
  const kept = valid.slice(0, limit)
  const dropped = valid.slice(limit)
  loaded = kept
  await cleanupOrphans(kept)
  if (dropped.length > 0 || kept.length !== items.length) {
    await removeFiles(dropped.flatMap((item) => [item.file, item.thumb]))
    await saveIndex(kept)
  }
  return kept
}

function makeThumbnail(buffer: Buffer): Buffer {
  const image = nativeImage.createFromBuffer(buffer)
  const size = image.getSize()
  if (size.width <= 0 || size.height <= 0) return buffer
  const ratio = Math.min(1, THUMB_MAX_SIDE / Math.max(size.width, size.height))
  if (ratio >= 1) return image.toPNG()
  const width = Math.max(1, Math.round(size.width * ratio))
  const height = Math.max(1, Math.round(size.height * ratio))
  return image.resize({ width, height, quality: 'good' }).toPNG()
}

/** 截图成功完成后调用；调用方需保证历史重贴等回放路径不重复写入 */
export function recordPinHistory(
  buffer: Buffer,
  width: number,
  height: number,
  source: HistorySource = 'pin',
): Promise<void> {
  return enqueue(async () => {
    const items = await ensureLoaded()
    const dir = pinHistoryDir()
    const id = randomUUID()
    const file = `${FILE_PREFIX}${id}.png`
    const thumb = `${FILE_PREFIX}${id}-thumb.png`

    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, file), buffer)
    await writeFile(join(dir, thumb), makeThumbnail(buffer))

    items.unshift({ id, createdAt: Date.now(), width, height, file, thumb, source })
    const dropped = items.splice(historyLimit())
    await removeFiles(dropped.flatMap((item) => [item.file, item.thumb]))
    await saveIndex(items)
    for (const listener of changeListeners) listener()
  })
}

/** 切换保留档位：调用方先保存配置，这里按新上限裁剪已有记录并落盘 */
export function setPinHistoryLimit(limit: HistoryLimit): Promise<void> {
  return enqueue(async () => {
    const items = await ensureLoaded()
    const dropped = items.splice(limit)
    if (dropped.length > 0) {
      await removeFiles(dropped.flatMap((item) => [item.file, item.thumb]))
      await saveIndex(items)
    }
    for (const listener of changeListeners) listener()
  })
}

export function listPinHistory(): Promise<PinHistoryItem[]> {
  return enqueue(async () => {
    const items = await ensureLoaded()
    const dir = pinHistoryDir()
    const result: PinHistoryItem[] = []
    for (const item of items) {
      const thumb = await readFile(join(dir, item.thumb)).catch(() => null)
      if (!thumb) continue
      result.push({
        id: item.id,
        createdAt: item.createdAt,
        imageWidth: item.width,
        imageHeight: item.height,
        thumbUrl: `data:image/png;base64,${thumb.toString('base64')}`,
        source: item.source,
      })
    }
    return result
  })
}

/** 历史是否有条目（只查索引，不读缩略图） */
export function hasPinHistory(): Promise<boolean> {
  return enqueue(async () => {
    const items = await ensureLoaded()
    return items.length > 0
  })
}

export function deletePinHistory(id: string): Promise<void> {
  return enqueue(async () => {
    const items = await ensureLoaded()
    const index = items.findIndex((item) => item.id === id)
    if (index < 0) return
    const [removed] = items.splice(index, 1)
    await removeFiles([removed.file, removed.thumb])
    await saveIndex(items)
    for (const listener of changeListeners) listener()
  })
}

export function clearPinHistory(): Promise<void> {
  return enqueue(async () => {
    const items = await ensureLoaded()
    if (items.length === 0) return
    await removeFiles(items.flatMap((item) => [item.file, item.thumb]))
    items.length = 0
    await saveIndex(items)
    for (const listener of changeListeners) listener()
  })
}

async function readHistoryBuffer(id: string): Promise<{ buffer: Buffer; width: number; height: number } | null> {
  const item = await enqueue(async () => {
    const items = await ensureLoaded()
    return items.find((entry) => entry.id === id) ?? null
  })
  if (!item) return null
  try {
    const buffer = await readFile(join(pinHistoryDir(), item.file))
    return { buffer, width: item.width, height: item.height }
  } catch {
    return null
  }
}

/** 历史条目复制到剪贴板（不写入新历史） */
export async function copyPinHistoryItem(id: string): Promise<SetHotkeyResult> {
  const data = await readHistoryBuffer(id)
  if (!data) return { ok: false, error: '历史图片不存在' }
  const image = nativeImage.createFromBuffer(data.buffer)
  if (image.isEmpty()) return { ok: false, error: '图片无法读取' }
  clipboard.writeImage(image)
  return { ok: true }
}

/** 历史条目另存为（不写入新历史） */
export async function savePinHistoryItem(id: string): Promise<SetHotkeyResult> {
  const data = await readHistoryBuffer(id)
  if (!data) return { ok: false, error: '历史图片不存在' }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
  const result = await dialog.showSaveDialog({
    title: '另存为',
    defaultPath: join(app.getPath('pictures'), `snip-${stamp}.png`),
    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
  })
  if (result.canceled || !result.filePath) return { ok: false, error: '已取消' }
  try {
    await writeFile(result.filePath, data.buffer)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

export interface PinHistoryImage {
  buffer: Buffer
  width: number
  height: number
}

/**
 * 历史重贴：只读取原图与像素尺寸，落点由调用方（贴图服务）按当前光标计算。
 * 不经过截图流程，所以没有选区。
 */
export function readHistoryImage(id: string): Promise<PinHistoryImage | null> {
  return enqueue(async () => {
    const items = await ensureLoaded()
    const item = items.find((entry) => entry.id === id)
    if (!item) return null
    try {
      const buffer = await readFile(join(pinHistoryDir(), item.file))
      return { buffer, width: item.width, height: item.height }
    } catch {
      return null
    }
  })
}
