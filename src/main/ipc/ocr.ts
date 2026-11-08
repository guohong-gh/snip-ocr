import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import { appState, broadcastState } from '../appState'
import { saveConfig } from '../config'
import { applyOcrLanguage, listOcrLanguages } from '../ocr'

export function registerOcrIpc(): string[] {
  ipcMain.handle(IPC.listOcrLanguages, () => listOcrLanguages())
  ipcMain.handle(IPC.setOcrLanguage, (_event, tag: unknown) =>
    applyOcrLanguage(tag, {
      save: (value) => saveConfig({ ocrLanguage: value }),
      apply: (value) => {
        appState.ocrLanguage = value
      },
      broadcast: () => broadcastState(),
    }),
  )
  return [IPC.listOcrLanguages, IPC.setOcrLanguage]
}
