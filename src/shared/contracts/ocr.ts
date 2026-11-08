/** OCR 语言通道 */
export const OCR_CHANNELS = {
  listOcrLanguages: 'snip:list-ocr-languages',
  setOcrLanguage: 'snip:set-ocr-language',
} as const

/** 系统已安装的 OCR 语言（tag 传给 PowerShell/WinRT，displayName 给界面） */
export interface OcrLanguageInfo {
  tag: string
  displayName: string
}

export interface OcrLanguagesResult {
  languages: OcrLanguageInfo[]
  /** 枚举失败时如实返回原因，不编造语言列表 */
  error?: string
}
