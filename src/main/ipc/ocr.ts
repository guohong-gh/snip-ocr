import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import { listOcrLanguages, setOcrLanguage } from '../ocr'

export function registerOcrIpc(): string[] {
  ipcMain.handle(IPC.listOcrLanguages, () => listOcrLanguages())
  ipcMain.handle(IPC.setOcrLanguage, (_event, tag: unknown) => setOcrLanguage(tag))
  return [IPC.listOcrLanguages, IPC.setOcrLanguage]
}
