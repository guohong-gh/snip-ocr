import { app, ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import { homeWindowAction, markHomeReady } from '../homeWindow'
import { pinService } from '../pin'

export interface AppWindowIpcHandlers {
  startCapture(): Promise<void>
  pinLast(): Promise<void>
}

/** 主窗生命周期、截图入口与贴图批量关闭通道 */
export function registerAppWindowIpc(handlers: AppWindowIpcHandlers): string[] {
  ipcMain.on(IPC.homeStartCapture, () => void handlers.startCapture())
  ipcMain.on(IPC.pinLast, () => void handlers.pinLast())
  ipcMain.on(IPC.pinCloseAll, () => pinService.closeAll())
  ipcMain.on(IPC.homeWindowAction, (_event, action: unknown) => {
    if (action === 'close' || action === 'minimize') homeWindowAction(action)
  })
  ipcMain.on(IPC.quitApp, () => app.quit())
  ipcMain.on(IPC.homeReady, () => markHomeReady())
  return [
    IPC.homeStartCapture,
    IPC.pinLast,
    IPC.pinCloseAll,
    IPC.homeWindowAction,
    IPC.quitApp,
    IPC.homeReady,
  ]
}
