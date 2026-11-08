import { unlink } from 'node:fs/promises'

/** 临时文件删除重试次数与间隔：所有清理路径共用同一份定义 */
const REMOVE_RETRIES = 6
const REMOVE_RETRY_DELAY_MS = 100

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 删除临时文件；被渲染进程短暂占用时按固定间隔重试，最终放弃并记日志
 * （下次启动的 init() 会再次清理）。ENOENT 视为已删除成功。
 */
export async function removeFileEventually(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < REMOVE_RETRIES; attempt += 1) {
    try {
      await unlink(filePath)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      if (attempt === REMOVE_RETRIES - 1) {
        console.error('[snip] temp cleanup failed:', filePath, error)
        return
      }
      await delay(REMOVE_RETRY_DELAY_MS)
    }
  }
}
