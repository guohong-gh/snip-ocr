import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { iconPng, icoPng } from './icon-art.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// 应用图标（assets/icon.*、build/icon.*）是手工精修产物，不在生成链路内，本脚本只生成托盘图标
const trayIcoSizes = [16, 20, 24, 32, 40]

function write(dir, name, buffer, label) {
  const target = resolve(projectRoot, dir)
  mkdirSync(target, { recursive: true })
  const file = join(target, name)
  writeFileSync(file, buffer)
  console.log(`generated ${file} ${label}`)
}

write('assets', 'tray.png', iconPng(32, 'tray'), '(tray 32x32)')
write(
  'assets',
  'tray.ico',
  icoPng(trayIcoSizes.map((size) => ({ size, png: iconPng(size, 'tray') }))),
  `(tray ico ${trayIcoSizes.join('/')})`,
)
