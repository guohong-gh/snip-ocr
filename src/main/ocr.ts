import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, nativeImage } from 'electron'
import type { OcrLanguageInfo, OcrLanguagesResult, SetHotkeyResult } from '@shared/ipc'
import { loadConfig } from './config'

const execFileAsync = promisify(execFile)

const OCR_TIMEOUT_MS = 15000
const OCR_LANGUAGE_TIMEOUT_MS = 10000
const REMOVE_RETRIES = 4
const REMOVE_RETRY_DELAY_MS = 100
/** 超过该像素数视为整屏/大视野，原生字号已够大，放大只增加耗时 */
const OCR_UPSCALE_MAX_PIXELS = 1_000_000
/** 放大后最长边上限，避免触到 OcrEngine.MaxImageDimension */
const OCR_UPSCALE_MAX_SIDE = 4000
const OCR_UPSCALE_FACTOR = 2
/** 微裁切（单行短标签）在原生尺寸下识别更准，放大反而掉字 */
const OCR_MICRO_CROP_MAX_WIDTH = 400
const OCR_MICRO_CROP_MAX_HEIGHT = 80

export interface OcrResult {
  text: string
  language: string
}

export interface OcrWordBox {
  text: string
  x: number
  y: number
  width: number
  height: number
}

export interface OcrLineBox {
  text: string
  x: number
  y: number
  width: number
  height: number
  words: OcrWordBox[]
}

const FULL_WIDTH_TO_HALF: Record<string, string> = {
  '．': '.',
  '％': '%',
  '－': '-',
  '〜': '-',
  '＃': '#',
  '＠': '@',
  '＿': '_',
  '＋': '+',
  '＝': '=',
}

/**
 * Windows 中文引擎会逐字插入空格、把 ASCII 标点识别成全角、把连字符/小数点认成汉字或全角逗号，
 * 这里只做可逆的排版修复，保留英文单词间距。
 */
export function normalizeOcrText(raw: string): string {
  const cjk = '\\p{Script=Han}'
  const punct = '，。：；！？、（）《》“”‘’【】'
  return (
    raw
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      // 数字之间的「一」是引擎把连字符认成了汉字（2026 一 11 一 04）
      .replace(/(?<=\d) ?一 ?(?=\d)/g, '-')
      // 数字被空格拆开（1 5000 → 15000）
      .replace(/(?<=\d) (?=\d)/g, '')
      .replace(/[．％－〜＃＠＿＋＝]/g, (char) => FULL_WIDTH_TO_HALF[char] ?? char)
      // 小数点、百分号常被识别成全角标点或间隔点（98 ， 5 ％ / 98 · 5% → 98.5%）
      .replace(/(?<=\d) ?， ?(?=\d)/g, '.')
      .replace(/(?<=\d) ?· ?(?=\d)/g, '.')
      .replace(/(?<=\d) ?(?=%)/g, '')
      .replace(/[一·]\s*>(?=\s*\d)/g, '->')
      // 英文/数字内部标点两侧不应有空格（v0 ． 1 ． 0 → v0.1.0）
      .replace(/(?<=[A-Za-z0-9]) (?=[.,])/g, '')
      .replace(/(?<=[.,]) (?=[A-Za-z0-9])/g, '')
      // 中文标点后不需要空格
      .replace(new RegExp(`([${punct}]) `, 'g'), '$1')
      // 汉字之间、汉字与中文标点之间的空格
      .replace(new RegExp(`(${cjk}) (?=${cjk})`, 'gu'), '$1')
      .replace(new RegExp(`(${cjk}) (?=[${punct}])`, 'gu'), '$1')
      .replace(new RegExp(`([${punct}]) (?=${cjk})`, 'gu'), '$1')
      .replace(/ ?\n ?/g, '\n')
      .trim()
  )
}

const HAN_PATTERN = /\p{Script=Han}/u
const LATIN_PATTERN = /[A-Za-z0-9]/

/** 按尺寸自适应：大视野与微裁切保持原样，其余小字号裁切 2× 放大（实测 3× 无额外收益） */
function ocrScaleFactor(width: number, height: number): number {
  if (width * height > OCR_UPSCALE_MAX_PIXELS) return 1
  if (width <= OCR_MICRO_CROP_MAX_WIDTH && height <= OCR_MICRO_CROP_MAX_HEIGHT) return 1
  if (Math.max(width, height) * OCR_UPSCALE_FACTOR > OCR_UPSCALE_MAX_SIDE) return 1
  return OCR_UPSCALE_FACTOR
}

function prepareImageForOcr(buffer: Buffer): Buffer {
  const image = nativeImage.createFromBuffer(buffer)
  if (image.isEmpty()) return buffer
  const { width, height } = image.getSize()
  const factor = ocrScaleFactor(width, height)
  if (factor === 1) return buffer
  return image
    .resize({ width: width * factor, height: height * factor, quality: 'best' })
    .toPNG()
}

function lineOverlap(a: OcrLineBox, b: OcrLineBox): number {
  const top = Math.max(a.y, b.y)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (bottom <= top) return 0
  const vertical = (bottom - top) / (Math.min(a.height, b.height) || 1)
  const left = Math.max(a.x, b.x)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const horizontal = right > left ? (right - left) / (Math.min(a.width, b.width) || 1) : 0
  return vertical * 0.7 + Math.min(horizontal, 1) * 0.3
}

function wordInside(word: OcrWordBox, box: OcrWordBox): boolean {
  const centerX = word.x + word.width / 2
  const centerY = word.y + word.height / 2
  return (
    centerX >= box.x &&
    centerX <= box.x + box.width &&
    centerY >= box.y &&
    centerY <= box.y + box.height
  )
}

/** 混排行：汉字词保留中文引擎结果，拉丁词改用英文引擎的词框结果（重叠的中文误读直接丢弃） */
function mergeMixedLine(zhLine: OcrLineBox, enLine: OcrLineBox): string {
  const latinWords = enLine.words.filter(
    (word) => !HAN_PATTERN.test(word.text) && LATIN_PATTERN.test(word.text),
  )
  const kept = zhLine.words.filter((word) => !latinWords.some((box) => wordInside(word, box)))
  const tokens = [...kept, ...latinWords].sort((a, b) => a.x - b.x || a.y - b.y)
  const merged = tokens.map((word) => word.text).join(' ')
  return HAN_PATTERN.test(merged) ? merged : zhLine.text
}

/**
 * 双引擎合并规则：
 * 1. 行对齐：按垂直重叠率（70%）+ 水平重叠率（30%）打分，≥0.5 视为同一行。
 * 2. 纯中文行用中文引擎；纯拉丁行（含字母/数字且无汉字）用英文引擎。
 * 3. 中英混排行按词框合并：英文引擎的拉丁词替换同位置的中文误读，其余保留中文词。
 * 4. 中文引擎漏掉的纯拉丁行，若与任何中文行都不重叠，则补回并按 y/x 排序。
 */
export function mergeOcrLineBoxes(zhLines: OcrLineBox[], enLines: OcrLineBox[] | null): OcrLineBox[] {
  if (!enLines || enLines.length === 0) {
    return zhLines.filter((line) => line.text)
  }
  const matched = new Set<number>()
  const output: OcrLineBox[] = []
  for (const zhLine of zhLines) {
    let bestIndex = -1
    let bestScore = 0
    enLines.forEach((enLine, index) => {
      const score = lineOverlap(zhLine, enLine)
      if (score > bestScore) {
        bestScore = score
        bestIndex = index
      }
    })
    const enLine = bestScore >= 0.5 ? enLines[bestIndex] : null
    if (enLine) matched.add(bestIndex)
    let text = zhLine.text
    if (!text) {
      text = enLine?.text ?? ''
    } else if (!HAN_PATTERN.test(text) && LATIN_PATTERN.test(text) && enLine?.text) {
      text = enLine.text
    } else if (HAN_PATTERN.test(text) && LATIN_PATTERN.test(text) && enLine) {
      text = mergeMixedLine(zhLine, enLine)
    }
    if (text) output.push({ ...zhLine, text })
  }
  enLines.forEach((enLine, index) => {
    if (matched.has(index) || !enLine.text) return
    if (!LATIN_PATTERN.test(enLine.text) || HAN_PATTERN.test(enLine.text)) return
    if (zhLines.some((zhLine) => lineOverlap(zhLine, enLine) >= 0.5)) return
    output.push(enLine)
  })
  output.sort((a, b) => a.y - b.y || a.x - b.x)
  return output
}

export function mergeOcrLines(zhLines: OcrLineBox[], enLines: OcrLineBox[] | null): string {
  return mergeOcrLineBoxes(zhLines, enLines)
    .map((line) => line.text)
    .join('\n')
}

/** 长图分块高度与重叠（原图像素），重叠区用于跨块半行/断词去重 */
export const OCR_CHUNK_HEIGHT = 1600
export const OCR_CHUNK_OVERLAP = 100
/** WinRT OcrEngine.MaxImageDimension 的单边上限（文档值 2600） */
const OCR_MAX_SIDE = 2600

export interface OcrChunkPlan {
  y: number
  height: number
}

export interface OcrChunkLines {
  offsetY: number
  lines: OcrLineBox[]
}

/** 按固定高度切块，相邻块重叠 100px；剩余不足一个重叠高度时并入上一块 */
export function planOcrChunks(height: number): OcrChunkPlan[] {
  if (height <= 0) return []
  const step = OCR_CHUNK_HEIGHT - OCR_CHUNK_OVERLAP
  const chunks: OcrChunkPlan[] = []
  for (let y = 0; y < height; y += step) {
    const remaining = height - y
    if (remaining <= OCR_CHUNK_OVERLAP && chunks.length > 0) {
      chunks[chunks.length - 1].height = height - chunks[chunks.length - 1].y
      break
    }
    chunks.push({ y, height: Math.min(OCR_CHUNK_HEIGHT, remaining) })
  }
  return chunks
}

/** 宽度超过 WinRT 单边上限时等比缩放，避免整块被引擎拒绝 */
function scaleForWidth(width: number): number {
  return width > OCR_MAX_SIDE ? OCR_MAX_SIDE / width : 1
}

/** 把一张图按高度裁成 OCR 块并记录块在图内的 y；宽度超上限时先等比缩放 */
function sliceImageForOcr(buffer: Buffer): Array<{ buffer: Buffer; y: number }> {
  const image = nativeImage.createFromBuffer(buffer)
  if (image.isEmpty()) return []
  const { width, height } = image.getSize()
  const scale = scaleForWidth(width)
  const base =
    scale < 1
      ? image.resize({ width: OCR_MAX_SIDE, height: Math.max(1, Math.round(height * scale)), quality: 'best' })
      : image
  const size = base.getSize()
  return planOcrChunks(size.height).map((chunk) => ({
    buffer: base.crop({ x: 0, y: chunk.y, width: size.width, height: chunk.height }).toPNG(),
    y: chunk.y,
  }))
}

/** 把一张图按高度裁成 OCR 块；宽度超上限时先等比缩放 */
export function splitImageForOcr(buffer: Buffer): Buffer[] {
  return sliceImageForOcr(buffer).map((slice) => slice.buffer)
}

/** 按阅读顺序拼接块行：重叠区同文本去重，前缀断词取较长者，残行丢弃 */
export function mergeChunkLines(chunks: OcrChunkLines[]): string {
  const flat = chunks.flatMap((chunk) =>
    chunk.lines.map((line) => ({ ...line, y: chunk.offsetY + line.y })),
  )
  if (flat.length === 0) return ''
  const heights = flat.map((line) => line.height).sort((a, b) => a - b)
  const median = heights[Math.floor(heights.length / 2)] || 0
  flat.sort((a, b) => a.y - b.y || a.x - b.x)
  const kept: OcrLineBox[] = []
  for (const line of flat) {
    if (!line.text) continue
    const prev = kept[kept.length - 1]
    const nearby =
      prev &&
      Math.abs(line.y + line.height / 2 - (prev.y + prev.height / 2)) <
        Math.max(prev.height, line.height, 1) * 0.75
    if (nearby && (prev.text === line.text || line.text.startsWith(prev.text) || prev.text.startsWith(line.text))) {
      if (line.text.length > prev.text.length) kept[kept.length - 1] = line
      continue
    }
    if (median > 0 && line.height < median * 0.6) continue
    kept.push(line)
  }
  return kept.map((line) => line.text).join('\n')
}

const OCR_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

function Await($WinRtTask, [Type]$ResultType) {
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
    })[0]
  if (-not $asTask) { throw 'AsTask overload not found' }
  $netTask = $asTask.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

function Get-OcrLines($engine, $bitmap) {
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = New-Object System.Collections.ArrayList
  foreach ($line in $result.Lines) {
    $words = New-Object System.Collections.ArrayList
    $minX = [double]::MaxValue; $minY = [double]::MaxValue; $maxX = 0; $maxY = 0
    foreach ($word in $line.Words) {
      $rect = $word.BoundingRect
      $null = $words.Add([PSCustomObject]@{
        t = $word.Text
        x = [Math]::Round($rect.X, 1)
        y = [Math]::Round($rect.Y, 1)
        w = [Math]::Round($rect.Width, 1)
        h = [Math]::Round($rect.Height, 1)
      })
      if ($rect.X -lt $minX) { $minX = $rect.X }
      if ($rect.Y -lt $minY) { $minY = $rect.Y }
      if (($rect.X + $rect.Width) -gt $maxX) { $maxX = $rect.X + $rect.Width }
      if (($rect.Y + $rect.Height) -gt $maxY) { $maxY = $rect.Y + $rect.Height }
    }
    if ($words.Count -eq 0) { $minX = 0; $minY = 0; $maxX = 0; $maxY = 0 }
    $null = $lines.Add([PSCustomObject]@{
      t = $line.Text
      x = [Math]::Round($minX, 1)
      y = [Math]::Round($minY, 1)
      w = [Math]::Round($maxX - $minX, 1)
      h = [Math]::Round($maxY - $minY, 1)
      ws = @($words)
    })
  }
  return , $lines
}

try {
  $imagePath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__IMAGE_PATH_B64__'))
  $imagePath = [IO.Path]::GetFullPath($imagePath)
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($imagePath)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $langs = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
  $requestedTag = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__OCR_LANGUAGE_B64__'))
  $zhPick = $null
  if ($requestedTag) {
    $zhPick = $langs | Where-Object { $_.LanguageTag -eq $requestedTag } | Select-Object -First 1
  }
  if (-not $zhPick) { $zhPick = $langs | Where-Object { $_.LanguageTag -like 'zh-Hans*' } | Select-Object -First 1 }
  if (-not $zhPick) { $zhPick = $langs | Where-Object { $_.LanguageTag -like 'zh*' } | Select-Object -First 1 }
  if (-not $zhPick) { $zhPick = $langs | Select-Object -First 1 }
  if (-not $zhPick) { throw 'NO_OCR_LANGUAGE' }
  $zhEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($zhPick)
  if (-not $zhEngine) { throw 'NO_OCR_LANGUAGE' }

  $primaryTag = $zhEngine.RecognizerLanguage.LanguageTag
  $enPick = $langs | Where-Object { $_.LanguageTag -eq 'en-US' -and $_.LanguageTag -ne $primaryTag } | Select-Object -First 1
  $enEngine = $null
  if ($enPick) { $enEngine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($enPick) }

  $zhLines = Get-OcrLines $zhEngine $bitmap
  $enLines = $null
  if ($enEngine) { $enLines = Get-OcrLines $enEngine $bitmap }
  $payload = [PSCustomObject]@{
    language = $zhEngine.RecognizerLanguage.LanguageTag
    zh       = @($zhLines)
    en       = if ($enLines) { @($enLines) } else { $null }
  } | ConvertTo-Json -Compress -Depth 6
  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`

const OCR_LANGUAGES_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$langs = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
$list = New-Object System.Collections.ArrayList
foreach ($lang in $langs) {
  $null = $list.Add([PSCustomObject]@{
    tag = $lang.LanguageTag
    displayName = $lang.DisplayName
    nativeName = $lang.NativeName
  })
}
$payload = [PSCustomObject]@{ languages = @($list) } | ConvertTo-Json -Compress -Depth 4
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
`

/** 系统已安装且可用的 OCR 语言；只在应用启动后枚举一次，失败如实返回 */
let languagesPromise: Promise<OcrLanguagesResult> | null = null

export function listOcrLanguages(): Promise<OcrLanguagesResult> {
  languagesPromise ??= queryOcrLanguages()
  return languagesPromise
}

async function queryOcrLanguages(): Promise<OcrLanguagesResult> {
  if (process.platform !== 'win32') return { languages: [], error: '桌面 OCR 仅支持 Windows' }
  try {
    const encoded = Buffer.from(OCR_LANGUAGES_SCRIPT, 'utf16le').toString('base64')
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { timeout: OCR_LANGUAGE_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' },
    )
    const payload = stdout.trim().split(/\r?\n/).filter(Boolean).pop()
    if (!payload) return { languages: [], error: '没有返回 OCR 语言清单' }
    const parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as { languages?: unknown }
    const raw: unknown[] = Array.isArray(parsed.languages) ? parsed.languages : parsed.languages ? [parsed.languages] : []
    const languages = raw
      .map((item) => item as Record<string, unknown>)
      .map((item) => ({
        tag: typeof item.tag === 'string' ? item.tag : '',
        displayName:
          typeof item.displayName === 'string' && item.displayName.trim()
            ? item.displayName
            : typeof item.tag === 'string'
              ? item.tag
              : '',
        nativeName: typeof item.nativeName === 'string' ? item.nativeName : '',
      }))
      .filter((item) => item.tag)
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map(({ tag, displayName }) => ({ tag, displayName }))
    return { languages }
  } catch (error) {
    return { languages: [], error: error instanceof Error ? error.message : String(error) }
  }
}

/** 选定的语言必须在系统已装清单里；否则返回 null，由调用方回退系统默认 */
export function resolveOcrLanguage(
  requested: string | null | undefined,
  available: readonly OcrLanguageInfo[],
): OcrLanguageInfo | null {
  const tag = requested?.trim()
  if (!tag) return null
  return available.find((language) => language.tag.toLowerCase() === tag.toLowerCase()) ?? null
}

export interface OcrLanguageStore {
  /** 持久化选定标签，空字符串表示跟随系统默认 */
  save(tag: string): void
  /** 同步内存状态 */
  apply(tag: string): void
  /** 通知界面刷新 */
  broadcast(): void
}

/** 校验并应用 OCR 语言选择：非法或未安装时回退系统默认 */
export async function applyOcrLanguage(
  tag: unknown,
  store: OcrLanguageStore,
): Promise<SetHotkeyResult> {
  if (typeof tag !== 'string') return { ok: false, error: '参数无效' }
  const requested = tag.trim()
  if (!requested) {
    store.save('')
    store.apply('')
    store.broadcast()
    return { ok: true }
  }
  const { languages, error } = await listOcrLanguages()
  if (languages.length === 0) {
    store.save('')
    store.apply('')
    store.broadcast()
    return {
      ok: false,
      error: error ? `无法读取系统 OCR 语言：${error}` : '系统未安装可用的 OCR 语言包',
    }
  }
  const match = resolveOcrLanguage(requested, languages)
  if (!match) {
    store.save('')
    store.apply('')
    store.broadcast()
    return { ok: false, error: `系统未安装 ${requested} 语言包，已回退系统默认` }
  }
  store.save(match.tag)
  store.apply(match.tag)
  store.broadcast()
  return { ok: true }
}

export function buildOcrScript(imagePath: string, languageTag: string): string {
  return OCR_SCRIPT.replace(
    '__IMAGE_PATH_B64__',
    Buffer.from(imagePath, 'utf8').toString('base64'),
  ).replace('__OCR_LANGUAGE_B64__', Buffer.from(languageTag, 'utf8').toString('base64'))
}

function toLineBoxes(value: unknown): OcrLineBox[] {
  const items: unknown[] = Array.isArray(value) ? value : value ? [value] : []
  return items
    .map((raw) => {
      const line = raw as Record<string, unknown>
      const wordsRaw: unknown[] = Array.isArray(line.ws) ? line.ws : line.ws ? [line.ws] : []
      const words = wordsRaw
        .map((item) => item as Record<string, unknown>)
        .map((word) => ({
          text: typeof word.t === 'string' ? word.t : '',
          x: Number(word.x) || 0,
          y: Number(word.y) || 0,
          width: Number(word.w) || 0,
          height: Number(word.h) || 0,
        }))
        .filter((word) => word.text.length > 0)
      return {
        text: typeof line.t === 'string' ? line.t : '',
        x: Number(line.x) || 0,
        y: Number(line.y) || 0,
        width: Number(line.w) || 0,
        height: Number(line.h) || 0,
        words,
      }
    })
    .filter((line) => line.text.length > 0 || line.words.length > 0)
}

function ocrTempDir(): string {
  return join(app.getPath('userData'), 'ocr')
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function removeFileEventually(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < REMOVE_RETRIES; attempt += 1) {
    try {
      await unlink(filePath)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return
      if (attempt === REMOVE_RETRIES - 1) return
      await delay(REMOVE_RETRY_DELAY_MS)
    }
  }
}

class OcrService {
  private initPromise: Promise<void> | null = null
  private queue: Promise<void> = Promise.resolve()

  private init(): Promise<void> {
    this.initPromise ??= (async () => {
      try {
        await mkdir(ocrTempDir(), { recursive: true })
        const files = await readdir(ocrTempDir())
        await Promise.all(
          files
            .filter((name) => name.startsWith('ocr-') && name.endsWith('.png'))
            .map((name) => unlink(join(ocrTempDir(), name)).catch(() => undefined)),
        )
      } catch (error) {
        console.error('[snip] ocr temp init failed:', error)
      }
    })()
    return this.initPromise
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  recognize(buffer: Buffer): Promise<OcrResult> {
    return this.enqueue(() => this.recognizeNow(buffer))
  }

  /** 长图分块识别：逐段按 1600px/100px 重叠切块，再按阅读顺序拼接 */
  recognizeLongImage(buffers: Buffer[]): Promise<OcrResult> {
    return this.enqueue(() => this.recognizeLongNow(buffers))
  }

  private async configuredLanguage(): Promise<string> {
    const requested = loadConfig().ocrLanguage
    if (!requested) return ''
    const { languages } = await listOcrLanguages()
    return resolveOcrLanguage(requested, languages)?.tag ?? ''
  }

  private async recognizeNow(buffer: Buffer): Promise<OcrResult> {
    const raw = await this.recognizeRaw(buffer, true, await this.configuredLanguage())
    const text = normalizeOcrText(
      raw.lines.length > 0 ? raw.lines.map((line) => line.text).join('\n') : raw.fallbackText,
    )
    return { text, language: raw.language }
  }

  private async recognizeLongNow(buffers: Buffer[]): Promise<OcrResult> {
    if (process.platform !== 'win32') throw new Error('桌面 OCR 仅支持 Windows')
    await this.init()
    const languageTag = await this.configuredLanguage()
    const chunks: OcrChunkLines[] = []
    let language = ''
    for (const buffer of buffers) {
      for (const slice of sliceImageForOcr(buffer)) {
        const raw = await this.recognizeRaw(slice.buffer, false, languageTag)
        if (!language && raw.language) language = raw.language
        chunks.push({ offsetY: slice.y, lines: raw.lines })
      }
    }
    return { text: normalizeOcrText(mergeChunkLines(chunks)), language }
  }

  private async recognizeRaw(
    buffer: Buffer,
    prepare: boolean,
    languageTag: string,
  ): Promise<{ lines: OcrLineBox[]; fallbackText: string; language: string }> {
    if (process.platform !== 'win32') throw new Error('桌面 OCR 仅支持 Windows')
    if (buffer.length === 0) throw new Error('截图数据为空')
    await this.init()

    const imagePath = join(ocrTempDir(), `ocr-${Date.now()}-${randomUUID()}.png`)
    await writeFile(imagePath, prepare ? prepareImageForOcr(buffer) : buffer)
    try {
      const script = buildOcrScript(imagePath, languageTag)
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { timeout: OCR_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      )
      const payload = stdout.trim().split(/\r?\n/).filter(Boolean).pop()
      if (!payload) throw new Error('OCR 没有返回结果')
      const parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as {
        language?: unknown
        text?: unknown
        zh?: unknown
        en?: unknown
      }
      const zhLines = toLineBoxes(parsed.zh)
      const enLines = parsed.en ? toLineBoxes(parsed.en) : null
      const lines = zhLines.length > 0 ? mergeOcrLineBoxes(zhLines, enLines) : []
      const fallbackText = typeof parsed.text === 'string' ? parsed.text : ''
      const language = typeof parsed.language === 'string' ? parsed.language : ''
      return { lines, fallbackText, language }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('NO_OCR_LANGUAGE')) {
        throw new Error('系统未安装可用的 OCR 语言包')
      }
      if ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT' || message.includes('timed out')) {
        throw new Error('OCR 识别超时')
      }
      throw new Error(`OCR 识别失败：${message}`)
    } finally {
      await removeFileEventually(imagePath)
    }
  }
}

export const ocrService = new OcrService()
