import { dialog } from 'electron'
import { pinService } from './pin'

/** 托盘与主页共用：关闭全部贴图前统一二次确认，口径保持一致 */
export async function confirmAndCloseAllPins(): Promise<void> {
  const count = pinService.count
  if (count === 0) return
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'snip-ocr',
    message: `关闭全部 ${count} 张贴图？此操作不可恢复。`,
    buttons: ['取消', '关闭全部'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  if (response === 1) pinService.closeAll()
}
