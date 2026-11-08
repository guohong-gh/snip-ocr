import { ipcMain } from 'electron'
import { IPC, TRANSLATE_DIRECTIONS, type TranslateDirection } from '@shared/ipc'
import { translate, translateStatus } from '../translate'

export function registerTranslateIpc(): string[] {
  ipcMain.handle(IPC.translateStatus, () => translateStatus())
  ipcMain.handle(IPC.translate, (_event, text: unknown, direction: unknown) => {
    if (typeof text !== 'string') return { ok: false, reason: '参数无效' }
    if (
      typeof direction !== 'string' ||
      !(TRANSLATE_DIRECTIONS as readonly string[]).includes(direction)
    ) {
      return { ok: false, reason: '无效的翻译方向' }
    }
    return translate(text, direction as TranslateDirection)
  })
  return [IPC.translateStatus, IPC.translate]
}
