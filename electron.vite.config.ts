import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'

// electron-vite 始终以项目根为 cwd 运行
const alias = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        // 原生 napi 模块与库自带的截图视图由 node_modules 运行时解析，不参与打包
        external: ['node-screenshots', 'electron-screenshots', 'react-screenshots'],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
  },
  renderer: {
    resolve: { alias },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          pin: resolve('src/renderer/pin.html'),
        },
      },
    },
  },
})
