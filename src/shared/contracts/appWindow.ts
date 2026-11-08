/** 主窗生命周期与设置页入口通道 */
export const APP_WINDOW_CHANNELS = {
  homeWindowAction: 'snip:home-window-action',
  homeReady: 'snip:home-ready',
  homeOpenSettings: 'snip:home-open-settings',
  quitApp: 'snip:quit-app',
} as const

export type HomeWindowAction = 'close' | 'minimize'
