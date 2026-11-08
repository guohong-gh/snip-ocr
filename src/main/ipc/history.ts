import { ipcMain } from 'electron'
import { HISTORY_LIMITS, IPC, type HistoryLimit, type SetHotkeyResult } from '@shared/ipc'
import { appState, broadcastState } from '../appState'
import { saveConfig } from '../config'
import { pinService } from '../pin'
import {
  clearPinHistory,
  copyPinHistoryItem,
  deletePinHistory,
  listPinHistory,
  readHistoryImage,
  savePinHistoryItem,
  setPinHistoryLimit,
} from '../pinHistory'

export interface HistoryIpcHandlers {
  /** 历史条目变化后刷新「是否至少有一条」的可用态 */
  refreshState(): void
}

export function registerHistoryIpc(handlers: HistoryIpcHandlers): string[] {
  ipcMain.handle(IPC.setHistoryLimit, async (_event, limit: unknown) => {
    if (typeof limit !== 'number' || !(HISTORY_LIMITS as readonly number[]).includes(limit)) {
      return { ok: false, error: '无效的历史档位' } satisfies SetHotkeyResult
    }
    const next = limit as HistoryLimit
    saveConfig({ historyLimit: next })
    appState.historyLimit = next
    await setPinHistoryLimit(next)
    broadcastState()
    return { ok: true } satisfies SetHotkeyResult
  })

  ipcMain.handle(IPC.pinHistoryList, () => listPinHistory())
  ipcMain.handle(IPC.pinHistoryDelete, async (_event, id: unknown) => {
    if (typeof id === 'string' && id) await deletePinHistory(id)
    handlers.refreshState()
    return listPinHistory()
  })
  ipcMain.handle(IPC.pinHistoryClear, async () => {
    await clearPinHistory()
    handlers.refreshState()
    return listPinHistory()
  })
  ipcMain.handle(IPC.pinHistoryCopy, async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return { ok: false, error: '参数无效' } satisfies SetHotkeyResult
    return (await copyPinHistoryItem(id)) satisfies SetHotkeyResult
  })
  ipcMain.handle(IPC.pinHistorySave, async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return { ok: false, error: '参数无效' } satisfies SetHotkeyResult
    return (await savePinHistoryItem(id)) satisfies SetHotkeyResult
  })
  ipcMain.handle(IPC.pinHistoryPin, async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return { ok: false, error: '参数无效' } satisfies SetHotkeyResult
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
  })
  return [
    IPC.setHistoryLimit,
    IPC.pinHistoryList,
    IPC.pinHistoryDelete,
    IPC.pinHistoryClear,
    IPC.pinHistoryCopy,
    IPC.pinHistorySave,
    IPC.pinHistoryPin,
  ]
}
