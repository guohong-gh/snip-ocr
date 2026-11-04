import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, nativeImage } from 'electron'

const execFileAsync = promisify(execFile)

const OCR_TIMEOUT_MS = 15000
const REMOVE_RETRIES = 4
const REMOVE_RETRY_DELAY_MS = 100
/** 小裁切在 Windows OCR 上会整行漏识别，2× 上采样可恢复；大图本身够清晰，放大只增加耗时 */
const OCR_UPSCALE_MAX_PIXELS = 1_000_000
const OCR_UPSCALE_MAX_SIDE = 4000
const OCR_UPSCALE_FACTOR = 2

export interface OcrResult {
  text: string
  language: string
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

function prepareImageForOcr(buffer: Buffer): Buffer {
  const image = nativeImage.createFromBuffer(buffer)
  if (image.isEmpty()) return buffer
  const { width, height } = image.getSize()
  if (width * height > OCR_UPSCALE_MAX_PIXELS) return buffer
  if (Math.max(width, height) * OCR_UPSCALE_FACTOR > OCR_UPSCALE_MAX_SIDE) return buffer
  return image
    .resize({
      width: width * OCR_UPSCALE_FACTOR,
      height: height * OCR_UPSCALE_FACTOR,
      quality: 'best',
    })
    .toPNG()
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

try {
  $imagePath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__IMAGE_PATH_B64__'))
  $imagePath = [IO.Path]::GetFullPath($imagePath)
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($imagePath)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if (-not $engine) {
    $langs = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
    $pick = $langs | Where-Object { $_.LanguageTag -like 'zh-Hans*' } | Select-Object -First 1
    if (-not $pick) { $pick = $langs | Where-Object { $_.LanguageTag -like 'zh*' } | Select-Object -First 1 }
    if (-not $pick) { $pick = $langs | Select-Object -First 1 }
    if (-not $pick) { throw 'NO_OCR_LANGUAGE' }
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($pick)
  }
  if (-not $engine) { throw 'NO_OCR_LANGUAGE' }

  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $text = ($result.Lines | ForEach-Object { $_.Text }) -join ([string][char]10)
  $payload = [PSCustomObject]@{ language = $engine.RecognizerLanguage.LanguageTag; text = $text } | ConvertTo-Json -Compress
  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`

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

  recognize(buffer: Buffer): Promise<OcrResult> {
    const task = () => this.recognizeNow(buffer)
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async recognizeNow(buffer: Buffer): Promise<OcrResult> {
    if (process.platform !== 'win32') throw new Error('桌面 OCR 仅支持 Windows')
    if (buffer.length === 0) throw new Error('截图数据为空')
    await this.init()

    const imagePath = join(ocrTempDir(), `ocr-${Date.now()}-${randomUUID()}.png`)
    await writeFile(imagePath, prepareImageForOcr(buffer))
    try {
      const script = OCR_SCRIPT.replace(
        '__IMAGE_PATH_B64__',
        Buffer.from(imagePath, 'utf8').toString('base64'),
      )
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { timeout: OCR_TIMEOUT_MS, windowsHide: true, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' },
      )
      const payload = stdout.trim().split(/\r?\n/).filter(Boolean).pop()
      if (!payload) throw new Error('OCR 没有返回结果')
      const parsed = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as {
        language?: unknown
        text?: unknown
      }
      const text = typeof parsed.text === 'string' ? normalizeOcrText(parsed.text) : ''
      const language = typeof parsed.language === 'string' ? parsed.language : ''
      return { text, language }
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
