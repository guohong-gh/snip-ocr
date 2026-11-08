import { ipcMain } from 'electron'
import { IPC, type SetHotkeyResult } from '@shared/ipc'
import { applyHistoryLimit, clearHistory, pinHistoryItem, removeHistoryItem } from '../historyService'
import { copyPinHistoryItem, listPinHistory, savePinHistoryItem } from '../pinHistory'

/** 历史通道只做参数校验与协议适配，业务规则在 historyService */
export function registerHistoryIpc(): string[] {
  ipcMain.handle(IPC.setHistoryLimit, (_event, limit: unknown) => applyHistoryLimit(limit))
  ipcMain.handle(IPC.pinHistoryList, () => listPinHistory())
  ipcMain.handle(IPC.pinHistoryDelete, async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return listPinHistory()
    return removeHistoryItem(id)
  })
  ipcMain.handle(IPC.pinHistoryClear, () => clearHistory())
  ipcMain.handle(IPC.pinHistoryCopy, async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return { ok: false, error: '参数无效' } satisfies SetHotkeyResult
    return copyPinHistoryItem(id)
  })
  ipcMain.handle(IPC.pinHistorySave, async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return { ok: false, error: '参数无效' } satisfies SetHotkeyResult
    return savePinHistoryItem(id)
  })
  ipcMain.handle(IPC.pinHistoryPin, async (_event, id: unknown) => {
    if (typeof id !== 'string' || !id) return { ok: false, error: '参数无效' } satisfies SetHotkeyResult
    return pinHistoryItem(id)
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
