import { ipcMain } from 'electron'
import { IPC, type UpdateOptions } from '@shared/ipc'
import type { UpdateService } from '../update/updateService'

/** 检查更新域：五个入站通道，状态与进度由 UpdateService 主动推送 */
export function registerUpdateIpc(service: UpdateService): string[] {
  ipcMain.handle(IPC.updateCheck, () => service.check('manual'))
  ipcMain.handle(IPC.updateGetStatus, () => service.getStatus())
  ipcMain.handle(IPC.updateDownload, () => service.download())
  ipcMain.handle(IPC.updateCancel, () => service.cancel())
  ipcMain.handle(IPC.updateInstall, () => service.install())
  ipcMain.handle(IPC.updateSetOptions, (_event, options: unknown) => {
    if (typeof options !== 'object' || options === null) return service.getStatus()
    const source = options as Record<string, unknown>
    const patch: Partial<UpdateOptions> = {}
    if (typeof source.autoCheck === 'boolean') patch.autoCheck = source.autoCheck
    if (typeof source.autoDownload === 'boolean') patch.autoDownload = source.autoDownload
    return service.setOptions(patch)
  })
  return [
    IPC.updateCheck,
    IPC.updateGetStatus,
    IPC.updateDownload,
    IPC.updateCancel,
    IPC.updateInstall,
    IPC.updateSetOptions,
  ]
}
