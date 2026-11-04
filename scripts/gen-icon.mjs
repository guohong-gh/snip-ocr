import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { iconPng, icoPng } from './icon-art.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// build/ 是 electron-builder 的 buildResources（安装/任务栏图标），assets/ 进 asar（运行时窗口/托盘图标）
const appIcoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const trayIcoSizes = [16, 20, 24, 32, 40]

function write(dir, name, buffer, label) {
  const target = resolve(projectRoot, dir)
  mkdirSync(target, { recursive: true })
  const file = join(target, name)
  writeFileSync(file, buffer)
  console.log(`generated ${file} ${label}`)
}

write('build', 'icon.png', iconPng(512), '(512x512)')
write(
  'build',
  'icon.ico',
  icoPng(appIcoSizes.map((size) => ({ size, png: iconPng(size) }))),
  `(ico ${appIcoSizes.join('/')})`,
)
write('assets', 'icon.png', iconPng(256), '(256x256)')
write(
  'assets',
  'icon.ico',
  icoPng(appIcoSizes.map((size) => ({ size, png: iconPng(size) }))),
  `(ico ${appIcoSizes.join('/')})`,
)
write('assets', 'tray.png', iconPng(32, 'tray'), '(tray 32x32)')
write(
  'assets',
  'tray.ico',
  icoPng(trayIcoSizes.map((size) => ({ size, png: iconPng(size, 'tray') }))),
  `(tray ico ${trayIcoSizes.join('/')})`,
)
