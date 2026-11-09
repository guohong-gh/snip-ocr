/** 检查更新域通道：check / download / cancel / install / options 走 invoke，状态与进度由主进程推送 */
export const UPDATE_CHANNELS = {
  updateCheck: 'snip:update-check',
  updateDownload: 'snip:update-download',
  updateCancel: 'snip:update-cancel',
  updateInstall: 'snip:update-install',
  updateSetOptions: 'snip:update-set-options',
  updateGetStatus: 'snip:update-get-status',
  updateStatus: 'snip:update-status',
  updateProgress: 'snip:update-progress',
} as const

/** 更新只允许访问的主机（GitHub Releases）；自检据此确认没有第二更新源 */
export const UPDATE_ALLOWED_HOSTS = [
  'github.com',
  'api.github.com',
  // 资产下载落点（2026-11 实测）；旧域名保留以兼容此前行为
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
] as const

/** 设置页七态 */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'latest'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateStatus {
  phase: UpdatePhase
  /** 当前运行版本 */
  currentVersion: string
  /** 服务端最新版本；checking/idle/error 时为 null */
  latestVersion: string | null
  /** 新版本说明（纯文本，可能为空） */
  notes: string | null
  /** 上次失败原因；成功检查后清空 */
  error: string | null
  /** 上次失败时间（epoch ms） */
  errorAt: number | null
  /** 上次检查时间（epoch ms），用于 24h 节流与状态行展示 */
  checkedAt: number | null
  autoCheck: boolean
  autoDownload: boolean
  /** 当前构建是否支持在线更新（便携版或开发态为 false） */
  supported: boolean
}

/** 独立的轻量进度通道，不进 stateChanged / updateStatus */
export interface UpdateProgress {
  percent: number
  transferred: number
  total: number
}

export interface UpdateOptions {
  autoCheck: boolean
  autoDownload: boolean
}

export interface UpdateActionResult {
  ok: boolean
  error?: string
}
