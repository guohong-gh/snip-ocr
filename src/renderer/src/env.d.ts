/// <reference types="vite/client" />
import type { SnipApi } from '@shared/ipc'

declare global {
  interface Window {
    snip: SnipApi
  }
}

export {}
