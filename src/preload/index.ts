import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type HomeWindowAction,
  type IconTheme,
  type PinHistoryItem,
  type PinMeta,
  type SetHotkeyResult,
  type SnipApi,
  type SnipState,
  type TranslateResult,
  type TranslateStatus,
  type UpdateCheckResult,
} from '@shared/ipc'

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
  checkUpdate: () => ipcRenderer.invoke(IPC.checkUpdate) as Promise<UpdateCheckResult>,
  translateStatus: () => ipcRenderer.invoke(IPC.translateStatus) as Promise<TranslateStatus>,
  translateToChinese: (text: string) =>
    ipcRenderer.invoke(IPC.translateToChinese, text) as Promise<TranslateResult>,
  startCapture: () => ipcRenderer.send(IPC.homeStartCapture),
  pinLast: () => ipcRenderer.send(IPC.pinLast),
  closeAllPins: () => ipcRenderer.send(IPC.pinCloseAll),
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
  pin: {
    meta: () => ipcRenderer.invoke(IPC.pinMeta) as Promise<PinMeta | null>,
    ready: () => ipcRenderer.send(IPC.pinReady),
    close: () => ipcRenderer.send(IPC.pinClose),
    dragStart: (x, y) => ipcRenderer.send(IPC.pinDragStart, x, y),
    dragMove: (x, y) => ipcRenderer.send(IPC.pinDragMove, x, y),
    dragEnd: () => ipcRenderer.send(IPC.pinDragEnd),
    resizeStart: (direction, x, y) => ipcRenderer.send(IPC.pinResizeStart, direction, x, y),
    resizeMove: (x, y) => ipcRenderer.send(IPC.pinResizeMove, x, y),
    resizeEnd: () => ipcRenderer.send(IPC.pinResizeEnd),
  },
}

contextBridge.exposeInMainWorld('snip', api)
