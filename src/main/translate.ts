import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { TranslateResult, TranslateStatus } from '@shared/ipc'

const PLUGIN_DIR_NAME = 'translate-locally'
const EXE_NAME = 'translateLocally.exe'
const MODEL_SHORT_NAME = 'en-zh-base'
const TIMEOUT_MS = 30_000
const MAX_TEXT_LENGTH = 5000

/** 模型目录内必须齐全的文件，缺任一即视为未安装 */
const MODEL_FILES = [
  'config.intgemm8bitalpha.yml',
  'model_info.json',
  'model.enzh.intgemm.alphas.bin',
  'lex.50.50.enzh.s2t.bin',
  'srcvocab.enzh.spm',
  'trgvocab.enzh.spm',
]

/** 候选位置：程序数据目录（安装/绿色版）优先，其次是项目内 plugins/（开发态） */
function pluginCandidates(): string[] {
  return [
    join(app.getPath('userData'), 'plugins', PLUGIN_DIR_NAME),
    join(app.getAppPath(), 'plugins', PLUGIN_DIR_NAME),
  ]
}

function isInstalled(dir: string): boolean {
  const modelDir = join(dir, 'models', 'enzh')
  return existsSync(join(dir, EXE_NAME)) && MODEL_FILES.every((name) => existsSync(join(modelDir, name)))
}

export function translateStatus(): TranslateStatus {
  const candidates = pluginCandidates()
  const found = candidates.find(isInstalled) ?? null
  return { available: found !== null, pluginDir: found ?? candidates[0] }
}

interface RunOutcome {
  code: number | null
  timedOut: boolean
  error?: string
}

/** 一次性进程：翻译由用户手动触发，冷热启动只差几十毫秒，常驻反而要管理 idle/崩溃/残留 */
function runEngine(dir: string, inputPath: string, outputPath: string): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const child = spawn(
      join(dir, EXE_NAME),
      ['-m', MODEL_SHORT_NAME, '-i', inputPath, '-o', outputPath],
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

export async function translateToChinese(text: string): Promise<TranslateResult> {
  const content = text.trim()
  if (!content) return { ok: false, reason: '没有可翻译的文本' }
  if (content.length > MAX_TEXT_LENGTH) {
    return { ok: false, reason: `文本过长（上限 ${MAX_TEXT_LENGTH} 字）` }
  }
  const dir = pluginCandidates().find(isInstalled)
  if (!dir) return { ok: false, reason: '未安装翻译插件' }
  const workDir = join(app.getPath('userData'), 'translate')
  mkdirSync(workDir, { recursive: true })
  const stamp = `${Date.now()}-${randomUUID()}`
  const inputPath = join(workDir, `in-${stamp}.txt`)
  const outputPath = join(workDir, `out-${stamp}.txt`)
  writeFileSync(inputPath, content, 'utf8')
  try {
    const run = await runEngine(dir, inputPath, outputPath)
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
