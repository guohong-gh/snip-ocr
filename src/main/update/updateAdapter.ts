/** 更新适配器内部事件：把 electron-updater 的字符串事件名收敛在一处 */
export type UpdateAdapterEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string; notes: string | null }
  | { type: 'not-available'; version: string }
  | { type: 'progress'; percent: number; transferred: number; total: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string }
  | { type: 'cancelled' }

/**
 * 更新能力抽象。生产实现动态加载 electron-updater；
 * 自检注入假实现，保证不联网、不读写真实更新文件。
 */
export interface UpdateAdapter {
  check(): Promise<void>
  download(): Promise<void>
  cancel(): Promise<void>
  install(): Promise<void>
  subscribe(listener: (event: UpdateAdapterEvent) => void): () => void
}
