import { appState, broadcastState } from './appState'
import { saveConfig } from './config'
import { refreshTray } from './tray'
import { hotkeyRegistry, type HotkeySlot } from './hotkeyRegistry'
import { DEFAULT_HOTKEY, DEFAULT_PIN_HOTKEY } from '@shared/ipc'

/** 快捷键状态变化（含后台重试成功）统一同步到 AppState，并刷新托盘与主窗 */
export function refreshHotkeyState(slot: HotkeySlot): void {
  if (slot === 'capture') {
    const previous = appState.hotkey
    appState.hotkey = hotkeyRegistry.current('capture') ?? DEFAULT_HOTKEY
    appState.hotkeyError = hotkeyRegistry.error('capture')
    if (!appState.hotkeyError && appState.hotkey !== previous) saveConfig({ hotkey: appState.hotkey })
  } else {
    const previous = appState.pinHotkey
    appState.pinHotkey = hotkeyRegistry.current('pin') ?? DEFAULT_PIN_HOTKEY
    appState.pinHotkeyError = hotkeyRegistry.error('pin')
    if (!appState.pinHotkeyError && appState.pinHotkey !== previous) {
      saveConfig({ pinHotkey: appState.pinHotkey })
    }
  }
  refreshTray()
  broadcastState()
}
