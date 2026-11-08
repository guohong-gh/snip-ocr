import type { WebContents } from 'electron'
import { registeredIpcChannels } from './ipc/registry'
import { overlayBridgeRegistrationCount } from './overlayBridge'
import { screenshotService } from './screenshot'

/**
 * 测试专用访问出口：仅由 `--selftest` 动态加载，生产启动路径不导入。
 * 自检需要读取生产模块内部状态时集中从这里取，不再散落在各模块的公共接口上。
 */
export const testHooks = {
  /** 截图遮罩页 WebContents（自检注入输入事件与读取 DOM） */
  overlayView: (): WebContents | null => screenshotService.view,
  /** 已注册的入站 IPC 通道 */
  registeredIpcChannels,
  /** 翻译桥注册次数 */
  overlayBridgeRegistrationCount,
}
