import { app, ipcMain } from 'electron'
import { IPC, type HomeWindowAction } from '@shared/ipc'

export interface AppWindowIpcHandlers {
  startCapture(): Promise<void>
  pinLast(): Promise<void>
  closeAllPins(): void
  windowAction(action: HomeWindowAction): void
  markHomeReady(): void
}

/** 主窗生命周期、截图入口与贴图批量关闭通道 */
export function registerAppWindowIpc(handlers: AppWindowIpcHandlers): string[] {
  ipcMain.on(IPC.homeStartCapture, () => void handlers.startCapture())
  ipcMain.on(IPC.pinLast, () => void handlers.pinLast())
  ipcMain.on(IPC.pinCloseAll, () => handlers.closeAllPins())
  ipcMain.on(IPC.homeWindowAction, (_event, action: unknown) => {
    if (action === 'close' || action === 'minimize') handlers.windowAction(action)
  })
  ipcMain.on(IPC.quitApp, () => app.quit())
  ipcMain.on(IPC.homeReady, () => handlers.markHomeReady())
  return [
    IPC.homeStartCapture,
    IPC.pinLast,
    IPC.pinCloseAll,
    IPC.homeWindowAction,
    IPC.quitApp,
    IPC.homeReady,
  ]
}
