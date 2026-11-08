import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type {
  TranslateDirection,
  TranslateDirectionStatus,
  TranslateResult,
  TranslateStatus,
} from '@shared/ipc'

const PLUGIN_DIR_NAME = 'translate-locally'
const EXE_NAME = 'translateLocally.exe'
const TIMEOUT_MS = 30_000
const MAX_TEXT_LENGTH = 5000

interface ModelSpec {
  /** models/ 下的目录名 */
  dirName: string
  /** model_info.json 里的 shortName，传给 -m */
  shortName: string
  /** 状态提示用 */
  label: string
  /** 模型目录内必须齐全的文件，缺任一即视为该方向未安装 */
  files: string[]
}

/** 方向描述集中在一处，不在调用链里写死单方向的文件名 */
const MODELS: Record<TranslateDirection, ModelSpec> = {
  'en-zh': {
    dirName: 'enzh',
    shortName: 'en-zh-base',
    label: '英译中',
    files: [
      'config.intgemm8bitalpha.yml',
      'model_info.json',
      'model.enzh.intgemm.alphas.bin',
      'lex.50.50.enzh.s2t.bin',
      'srcvocab.enzh.spm',
      'trgvocab.enzh.spm',
    ],
  },
  'zh-en': {
    dirName: 'zhen',
    shortName: 'zh-en-base',
    label: '中译英',
    files: [
      'config.intgemm8bitalpha.yml',
      'model_info.json',
      'model.zhen.intgemm.alphas.bin',
      'lex.50.50.zhen.s2t.bin',
      'srcvocab.zhen.spm',
      'trgvocab.zhen.spm',
    ],
  },
}

/** 候选位置：程序数据目录（安装/绿色版）优先，其次是项目内 plugins/（开发态） */
function pluginCandidates(): string[] {
  return [
    join(app.getPath('userData'), 'plugins', PLUGIN_DIR_NAME),
    join(app.getAppPath(), 'plugins', PLUGIN_DIR_NAME),
  ]
}

function hasExe(dir: string): boolean {
  return existsSync(join(dir, EXE_NAME))
}

function hasModel(dir: string, spec: ModelSpec): boolean {
  const modelDir = join(dir, 'models', spec.dirName)
  return spec.files.every((name) => existsSync(join(modelDir, name)))
}

function installedDir(spec: ModelSpec): string | null {
  return pluginCandidates().find((dir) => hasExe(dir) && hasModel(dir, spec)) ?? null
}

function directionStatus(direction: TranslateDirection): TranslateDirectionStatus {
  if (installedDir(MODELS[direction])) return { available: true, reason: null }
  const pluginInstalled = pluginCandidates().some(hasExe)
  return {
    available: false,
    reason: pluginInstalled ? `未安装${MODELS[direction].label}模型` : '未安装翻译插件',
  }
}

export function translateStatus(): TranslateStatus {
  const candidates = pluginCandidates()
  return {
    pluginDir: candidates.find(hasExe) ?? candidates[0],
    directions: {
      'en-zh': directionStatus('en-zh'),
      'zh-en': directionStatus('zh-en'),
    },
  }
}

interface RunOutcome {
  code: number | null
  timedOut: boolean
  error?: string
}

/** 一次性进程：翻译由用户手动触发，冷热启动只差几十毫秒，常驻反而要管理 idle/崩溃/残留 */
function runEngine(
  dir: string,
  spec: ModelSpec,
  inputPath: string,
  outputPath: string,
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const child = spawn(
      join(dir, EXE_NAME),
      ['-m', spec.shortName, '-i', inputPath, '-o', outputPath],
      { cwd: join(dir, 'models'), windowsHide: true },
    )
    let settled = false
    let timer: NodeJS.Timeout | null = null
    const finish = (outcome: RunOutcome): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(outcome)
    }
    timer = setTimeout(() => {
      child.kill()
      finish({ code: null, timedOut: true })
    }, TIMEOUT_MS)
    child.on('error', (error) => finish({ code: null, timedOut: false, error: error.message }))
    child.on('close', (code) => finish({ code, timedOut: false }))
  })
}

function removeTemp(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // 文件仍被占用时忽略，不影响本次结果
  }
}

export async function translate(
  text: string,
  direction: TranslateDirection,
): Promise<TranslateResult> {
  const content = text.trim()
  if (!content) return { ok: false, reason: '没有可翻译的文本' }
  if (content.length > MAX_TEXT_LENGTH) {
    return { ok: false, reason: `文本过长（上限 ${MAX_TEXT_LENGTH} 字）` }
  }
  const spec = MODELS[direction]
  const dir = installedDir(spec)
  if (!dir) {
    const status = directionStatus(direction)
    return { ok: false, reason: status.reason ?? `未安装${spec.label}模型` }
  }
  const workDir = join(app.getPath('userData'), 'translate')
  mkdirSync(workDir, { recursive: true })
  const stamp = `${Date.now()}-${randomUUID()}`
  const inputPath = join(workDir, `in-${stamp}.txt`)
  const outputPath = join(workDir, `out-${stamp}.txt`)
  writeFileSync(inputPath, content, 'utf8')
  try {
    const run = await runEngine(dir, spec, inputPath, outputPath)
    if (run.timedOut) return { ok: false, reason: `翻译超时（${TIMEOUT_MS / 1000} 秒）` }
    if (run.error) return { ok: false, reason: `无法启动翻译引擎：${run.error}` }
    if (run.code !== 0) return { ok: false, reason: `翻译引擎异常退出（code ${run.code ?? '未知'}）` }
    if (!existsSync(outputPath)) return { ok: false, reason: '翻译引擎没有产生输出' }
    // 引擎输出是系统 ANSI（GB18030），必须转码；Electron 33 的 Node 20 完整 ICU 已实测支持
    const decoded = new TextDecoder('gb18030').decode(readFileSync(outputPath)).trim()
    if (!decoded) return { ok: false, reason: '翻译结果为空' }
    return { ok: true, text: decoded }
  } finally {
    removeTemp(inputPath)
    removeTemp(outputPath)
  }
}
