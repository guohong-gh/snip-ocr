import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import { pinService } from '../pin'

/** 贴图窗通道：按发送者 webContents id 路由到对应贴图实例 */
export function registerPinWindowIpc(): string[] {
  ipcMain.handle(IPC.pinMeta, (event) => pinService.metaFor(event.sender.id))
  ipcMain.on(IPC.pinReady, (event) => pinService.markReady(event.sender.id))
  ipcMain.on(IPC.pinClose, (event) => pinService.closeFor(event.sender.id))
  ipcMain.on(IPC.pinDragStart, (event, x: unknown, y: unknown) => {
    pinService.dragStart(event.sender.id, x, y)
  })
  ipcMain.on(IPC.pinDragMove, (event, x: unknown, y: unknown) => {
    pinService.dragMove(event.sender.id, x, y)
  })
  ipcMain.on(IPC.pinDragEnd, (event) => pinService.dragEnd(event.sender.id))
  ipcMain.on(IPC.pinResizeStart, (event, direction: unknown, x: unknown, y: unknown) => {
    pinService.resizeStart(event.sender.id, direction, x, y)
  })
  ipcMain.on(IPC.pinResizeMove, (event, x: unknown, y: unknown) => {
    pinService.resizeMove(event.sender.id, x, y)
  })
  ipcMain.on(IPC.pinResizeEnd, (event) => pinService.resizeEnd(event.sender.id))
  return [
    IPC.pinMeta,
    IPC.pinReady,
    IPC.pinClose,
    IPC.pinDragStart,
    IPC.pinDragMove,
    IPC.pinDragEnd,
    IPC.pinResizeStart,
    IPC.pinResizeMove,
    IPC.pinResizeEnd,
  ]
}
