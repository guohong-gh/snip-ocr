import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type HistoryLimit,
  type HomeWindowAction,
  type IconTheme,
  type OcrLanguagesResult,
  type PinApi,
  type PinHistoryItem,
  type PinMeta,
  type SetHotkeyResult,
  type SnipApi,
  type SnipState,
  type TranslateDirection,
  type TranslateResult,
  type TranslateStatus,
  type UpdateActionResult,
  type UpdateOptions,
  type UpdateProgress,
  type UpdateStatus,
} from '@shared/ipc'

const pinApi: PinApi = {
  meta: () => ipcRenderer.invoke(IPC.pinMeta) as Promise<PinMeta | null>,
  ready: () => ipcRenderer.send(IPC.pinReady),
  close: () => ipcRenderer.send(IPC.pinClose),
  dragStart: (x, y) => ipcRenderer.send(IPC.pinDragStart, x, y),
  dragMove: (x, y) => ipcRenderer.send(IPC.pinDragMove, x, y),
  dragEnd: () => ipcRenderer.send(IPC.pinDragEnd),
  resizeStart: (direction, x, y) => ipcRenderer.send(IPC.pinResizeStart, direction, x, y),
  resizeMove: (x, y) => ipcRenderer.send(IPC.pinResizeMove, x, y),
  resizeEnd: () => ipcRenderer.send(IPC.pinResizeEnd),
}

const api: SnipApi = {
  getState: () => ipcRenderer.invoke(IPC.getState) as Promise<SnipState>,
  setHotkey: (accelerator: string) => ipcRenderer.invoke(IPC.setHotkey, accelerator) as Promise<SetHotkeyResult>,
  setPinHotkey: (accelerator: string) =>
    ipcRenderer.invoke(IPC.setPinHotkey, accelerator) as Promise<SetHotkeyResult>,
  setAutostart: (enabled: boolean) =>
    ipcRenderer.invoke(IPC.setAutostart, enabled) as Promise<SetHotkeyResult>,
  setIconTheme: (theme: IconTheme) =>
    ipcRenderer.invoke(IPC.setIconTheme, theme) as Promise<SetHotkeyResult>,
  pickCustomIcon: () => ipcRenderer.invoke(IPC.pickCustomIcon) as Promise<SetHotkeyResult>,
  checkUpdate: () => ipcRenderer.invoke(IPC.updateCheck) as Promise<UpdateStatus>,
  getUpdateStatus: () => ipcRenderer.invoke(IPC.updateGetStatus) as Promise<UpdateStatus>,
  downloadUpdate: () => ipcRenderer.invoke(IPC.updateDownload) as Promise<UpdateStatus>,
  cancelUpdate: () => ipcRenderer.invoke(IPC.updateCancel) as Promise<UpdateStatus>,
  installUpdate: () => ipcRenderer.invoke(IPC.updateInstall) as Promise<UpdateActionResult>,
  setUpdateOptions: (options: Partial<UpdateOptions>) =>
    ipcRenderer.invoke(IPC.updateSetOptions, options) as Promise<UpdateStatus>,
  translateStatus: () => ipcRenderer.invoke(IPC.translateStatus) as Promise<TranslateStatus>,
  translate: (text: string, direction: TranslateDirection) =>
    ipcRenderer.invoke(IPC.translate, text, direction) as Promise<TranslateResult>,
  listOcrLanguages: () => ipcRenderer.invoke(IPC.listOcrLanguages) as Promise<OcrLanguagesResult>,
  setOcrLanguage: (tag: string) =>
    ipcRenderer.invoke(IPC.setOcrLanguage, tag) as Promise<SetHotkeyResult>,
  startCapture: () => ipcRenderer.send(IPC.homeStartCapture),
  pinLast: () => ipcRenderer.send(IPC.pinLast),
  closeAllPins: () => ipcRenderer.send(IPC.pinCloseAll),
  setHistoryLimit: (limit: HistoryLimit) =>
    ipcRenderer.invoke(IPC.setHistoryLimit, limit) as Promise<SetHotkeyResult>,
  listPinHistory: () => ipcRenderer.invoke(IPC.pinHistoryList) as Promise<PinHistoryItem[]>,
  deletePinHistory: (id: string) =>
    ipcRenderer.invoke(IPC.pinHistoryDelete, id) as Promise<PinHistoryItem[]>,
  clearPinHistory: () => ipcRenderer.invoke(IPC.pinHistoryClear) as Promise<PinHistoryItem[]>,
  pinFromHistory: (id: string) =>
    ipcRenderer.invoke(IPC.pinHistoryPin, id) as Promise<SetHotkeyResult>,
  copyFromHistory: (id: string) =>
    ipcRenderer.invoke(IPC.pinHistoryCopy, id) as Promise<SetHotkeyResult>,
  saveFromHistory: (id: string) =>
    ipcRenderer.invoke(IPC.pinHistorySave, id) as Promise<SetHotkeyResult>,
  windowAction: (action: HomeWindowAction) => ipcRenderer.send(IPC.homeWindowAction, action),
  quit: () => ipcRenderer.send(IPC.quitApp),
  ready: () => ipcRenderer.send(IPC.homeReady),
  onOpenSettings: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on(IPC.homeOpenSettings, handler)
    return () => {
      ipcRenderer.removeListener(IPC.homeOpenSettings, handler)
    }
  },
  onStateChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: SnipState): void => listener(state)
    ipcRenderer.on(IPC.stateChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC.stateChanged, handler)
    }
  },
  onPinHistoryChanged: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on(IPC.pinHistoryChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC.pinHistoryChanged, handler)
    }
  },
  onUpdateStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: UpdateStatus): void => listener(status)
    ipcRenderer.on(IPC.updateStatus, handler)
    return () => {
      ipcRenderer.removeListener(IPC.updateStatus, handler)
    }
  },
  onUpdateProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: UpdateProgress): void => listener(progress)
    ipcRenderer.on(IPC.updateProgress, handler)
    return () => {
      ipcRenderer.removeListener(IPC.updateProgress, handler)
    }
  },
  pin: pinApi,
}

/** 贴图页只暴露贴图窗 API，主窗只暴露完整 snip API */
const currentPathname = (globalThis as { location?: { pathname?: string } }).location?.pathname ?? ''
const isPinPage = currentPathname.endsWith('pin.html')

if (isPinPage) contextBridge.exposeInMainWorld('snipPin', pinApi)
else contextBridge.exposeInMainWorld('snip', api)
