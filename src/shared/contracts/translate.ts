/** 本地翻译通道 */
export const TRANSLATE_CHANNELS = {
  translateStatus: 'snip:translate-status',
  translate: 'snip:translate',
} as const

/** 翻译方向：英译中 / 中译英 */
export const TRANSLATE_DIRECTIONS = ['en-zh', 'zh-en'] as const
export type TranslateDirection = (typeof TRANSLATE_DIRECTIONS)[number]

export interface TranslateDirectionStatus {
  available: boolean
  /** 不可用原因（未安装插件 / 未安装对应模型） */
  reason: string | null
}

export interface TranslateStatus {
  /** 插件目录绝对路径，未安装时用于提示放置位置 */
  pluginDir: string
  directions: Record<TranslateDirection, TranslateDirectionStatus>
}

/** 失败时保留原文由调用方（侧栏）决定 */
export type TranslateResult = { ok: true; text: string } | { ok: false; reason: string }
