import { ipcMain } from 'electron'
import { IPC, type PinListAction } from '@shared/ipc'
import { pinService } from '../pin'
import { collapsePinList, togglePinList } from '../pinListWindow'

function isPinListAction(value: unknown): value is PinListAction {
  return value === 'bringToFront' || value === 'hide' || value === 'show'
}

/** 主窗与贴图列表面板通道 */
export function registerPinListIpc(): string[] {
  ipcMain.handle(IPC.pinListGet, () => pinService.list())
  ipcMain.on(IPC.pinListToggle, () => togglePinList())
  ipcMain.on(IPC.pinListClose, () => collapsePinList())
  ipcMain.on(IPC.pinListAction, (_event, id: unknown, action: unknown) => {
    if (typeof id !== 'number' || !Number.isFinite(id) || !isPinListAction(action)) return
    if (action === 'bringToFront') pinService.bringToFront(id)
    else pinService.setHidden(id, action === 'hide')
  })
  return [IPC.pinListGet, IPC.pinListToggle, IPC.pinListClose, IPC.pinListAction]
}
