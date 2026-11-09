import { APP_WINDOW_CHANNELS } from './contracts/appWindow'
import { CAPTURE_CHANNELS } from './contracts/capture'
import { HISTORY_CHANNELS } from './contracts/history'
import { OCR_CHANNELS } from './contracts/ocr'
import { PIN_WINDOW_CHANNELS } from './contracts/pinWindow'
import { SETTINGS_CHANNELS } from './contracts/settings'
import { TRANSLATE_CHANNELS } from './contracts/translate'
import { UPDATE_CHANNELS } from './contracts/update'
import type { HomeWindowAction } from './contracts/appWindow'
import type { HistoryLimit, PinHistoryItem } from './contracts/history'
import type { OcrLanguagesResult } from './contracts/ocr'
import type { PinApi } from './contracts/pinWindow'
import type { IconTheme, SnipState, SetHotkeyResult } from './contracts/settings'
import type { TranslateDirection, TranslateResult, TranslateStatus } from './contracts/translate'
import type { UpdateActionResult, UpdateOptions, UpdateProgress, UpdateStatus } from './contracts/update'

export * from './contracts/appWindow'
export * from './contracts/capture'
export * from './contracts/history'
export * from './contracts/ocr'
export * from './contracts/pinWindow'
export * from './contracts/settings'
export * from './contracts/translate'
export * from './contracts/update'

/** 全部 IPC 通道，按业务域组装 */
export const IPC = {
  ...SETTINGS_CHANNELS,
  ...HISTORY_CHANNELS,
  ...OCR_CHANNELS,
  ...TRANSLATE_CHANNELS,
  ...CAPTURE_CHANNELS,
  ...PIN_WINDOW_CHANNELS,
  ...APP_WINDOW_CHANNELS,
  ...UPDATE_CHANNELS,
} as const

export interface SnipApi {
  getState(): Promise<SnipState>
  setHotkey(accelerator: string): Promise<SetHotkeyResult>
  setPinHotkey(accelerator: string): Promise<SetHotkeyResult>
  setAutostart(enabled: boolean): Promise<SetHotkeyResult>
  setIconTheme(theme: IconTheme): Promise<SetHotkeyResult>
  pickCustomIcon(): Promise<SetHotkeyResult>
  checkUpdate(): Promise<UpdateStatus>
  getUpdateStatus(): Promise<UpdateStatus>
  downloadUpdate(): Promise<UpdateStatus>
  cancelUpdate(): Promise<UpdateStatus>
  installUpdate(): Promise<UpdateActionResult>
  setUpdateOptions(options: Partial<UpdateOptions>): Promise<UpdateStatus>
  translateStatus(): Promise<TranslateStatus>
  translate(text: string, direction: TranslateDirection): Promise<TranslateResult>
  listOcrLanguages(): Promise<OcrLanguagesResult>
  setOcrLanguage(tag: string): Promise<SetHotkeyResult>
  startCapture(): void
  pinLast(): void
  closeAllPins(): void
  setHistoryLimit(limit: HistoryLimit): Promise<SetHotkeyResult>
  listPinHistory(): Promise<PinHistoryItem[]>
  deletePinHistory(id: string): Promise<PinHistoryItem[]>
  clearPinHistory(): Promise<PinHistoryItem[]>
  pinFromHistory(id: string): Promise<SetHotkeyResult>
  copyFromHistory(id: string): Promise<SetHotkeyResult>
  saveFromHistory(id: string): Promise<SetHotkeyResult>
  windowAction(action: HomeWindowAction): void
  quit(): void
  ready(): void
  onOpenSettings(listener: () => void): () => void
  onStateChanged(listener: (state: SnipState) => void): () => void
  onPinHistoryChanged(listener: () => void): () => void
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void
  onUpdateProgress(listener: (progress: UpdateProgress) => void): () => void
  pin: PinApi
}
