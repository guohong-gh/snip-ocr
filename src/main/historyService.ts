import {
  HISTORY_LIMITS,
  type HistoryLimit,
  type PinHistoryItem,
  type SetHotkeyResult,
} from '@shared/ipc'
import { appState, broadcastState, refreshHistoryState } from './appState'
import { saveConfig } from './config'
import { pinService } from './pin'
import {
  clearPinHistory,
  deletePinHistory,
  listPinHistory,
  readHistoryImage,
  setPinHistoryLimit,
} from './pinHistory'

/** 校验并应用历史保留档位：保存配置、同步状态、按新上限裁剪索引 */
export async function applyHistoryLimit(limit: unknown): Promise<SetHotkeyResult> {
  if (typeof limit !== 'number' || !(HISTORY_LIMITS as readonly number[]).includes(limit)) {
    return { ok: false, error: '无效的历史档位' } satisfies SetHotkeyResult
  }
  const next = limit as HistoryLimit
  saveConfig({ historyLimit: next })
  appState.historyLimit = next
  await setPinHistoryLimit(next)
  broadcastState()
  return { ok: true } satisfies SetHotkeyResult
}

/** 删除条目并返回最新列表 */
export async function removeHistoryItem(id: string): Promise<PinHistoryItem[]> {
  await deletePinHistory(id)
  refreshHistoryState()
  return listPinHistory()
}

/** 清空历史并返回空列表 */
export async function clearHistory(): Promise<PinHistoryItem[]> {
  await clearPinHistory()
  refreshHistoryState()
  return listPinHistory()
}

/** 历史重贴：失败原因如实回传，由渲染层决定提示 */
export async function pinHistoryItem(id: string): Promise<SetHotkeyResult> {
  const image = await readHistoryImage(id)
  if (!image) return { ok: false, error: '该截图历史已不存在' } satisfies SetHotkeyResult
  try {
    await pinService.pinFromHistory(image)
    return { ok: true } satisfies SetHotkeyResult
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies SetHotkeyResult
  }
}
