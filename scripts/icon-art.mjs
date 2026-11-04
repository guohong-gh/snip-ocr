import { deflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

export function encodePng(size, pixels) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const PAPER = [246, 246, 241]
const INK = [24, 26, 23]
const SIGNAL = [36, 86, 184]
const PROOF = [195, 61, 38]

function roundedInside(x, y, inset, radius) {
  const half = 0.5 - inset
  const qx = Math.abs(x - 0.5) - (half - radius)
  const qy = Math.abs(y - 0.5) - (half - radius)
  const sdf = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
  return sdf
}

function cropMark(x, y, pad, arm, stroke) {
  const half = stroke / 2
  for (const sx of [0, 1]) {
    for (const sy of [0, 1]) {
      const ax = sx ? 1 - pad : pad
      const ay = sy ? 1 - pad : pad
      const x0 = sx ? ax - arm : ax
      const x1 = sx ? ax : ax + arm
      const y0 = sy ? ay - arm : ay
      const y1 = sy ? ay : ay + arm
      if (x >= x0 && x <= x1 && Math.abs(y - ay) <= half) return true
      if (y >= y0 && y <= y1 && Math.abs(x - ax) <= half) return true
    }
  }
  return false
}

function frameStroke(x, y, left, top, right, bottom, stroke) {
  const half = stroke / 2
  const outer = x >= left - half && x <= right + half && y >= top - half && y <= bottom + half
  if (!outer) return false
  const inner =
    x > left + half && x < right - half && y > top + half && y < bottom - half
  return !inner
}

function colorAt(x, y, size, variant) {
  const tray = variant === 'tray'
  const inset = tray ? 0.035 : 0.02
  const radius = tray ? 0.18 : 0.22
  const edge = roundedInside(x, y, inset, radius)
  if (edge > 0) return null

  const borderPx = Math.max(1, size * (tray ? 0.02 : 0.012))
  if (edge > -borderPx / size) return INK

  const pad = tray ? 0.11 : 0.13
  const arm = tray ? 0.15 : 0.13
  const cropStroke = Math.max(1, size * (tray ? 0.04 : 0.03)) / size
  if (cropMark(x, y, pad, arm, cropStroke)) return INK

  const left = tray ? 0.28 : 0.3
  const right = 1 - left
  const top = left
  const bottom = right
  const frameWidth = Math.max(1.2, size * (tray ? 0.05 : 0.04)) / size
  if (frameStroke(x, y, left, top, right, bottom, frameWidth)) return SIGNAL

  if (!tray && size >= 32) {
    const dotRadius = Math.max(1.5, size * 0.036) / size
    const dx = x - 0.73
    const dy = y - 0.27
    if (Math.hypot(dx, dy) <= dotRadius) return PROOF
  }

  return PAPER
}

/**
 * 纸白圆角底 + 墨色裁切角 + 信号蓝选框；大尺寸在选框右上角加朱砂校对点。
 * tray 变体省略小点、加粗裁切角，保证 16–40px 仍可辨认。
 */
export function draw(size, variant = 'app') {
  const px = Buffer.alloc(size * size * 4)
  const SS = size >= 64 ? 3 : 4
  const total = SS * SS
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let hits = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const color = colorAt((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size, size, variant)
          if (!color) continue
          hits++
          r += color[0]
          g += color[1]
          b += color[2]
        }
      }
      if (hits === 0) continue
      const i = (y * size + x) * 4
      px[i] = Math.round(r / hits)
      px[i + 1] = Math.round(g / hits)
      px[i + 2] = Math.round(b / hits)
      px[i + 3] = Math.round((255 * hits) / total)
    }
  }
  return px
}

export function iconPng(size, variant = 'app') {
  return encodePng(size, draw(size, variant))
}

/** PNG-compressed ICO；frames: [{ size, png }] */
export function icoPng(frames) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)

  const entries = Buffer.alloc(16 * frames.length)
  let offset = 6 + entries.length
  frames.forEach((frame, index) => {
    const entry = index * 16
    entries[entry] = frame.size >= 256 ? 0 : frame.size
    entries[entry + 1] = frame.size >= 256 ? 0 : frame.size
    entries[entry + 2] = 0
    entries[entry + 3] = 0
    entries.writeUInt16LE(1, entry + 4)
    entries.writeUInt16LE(32, entry + 6)
    entries.writeUInt32LE(frame.png.length, entry + 8)
    entries.writeUInt32LE(offset, entry + 12)
    offset += frame.png.length
  })

  return Buffer.concat([header, entries, ...frames.map((frame) => frame.png)])
}
