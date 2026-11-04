import { nativeImage } from 'electron'

/** 拼接结果最大高度（物理像素），超出直接报错，不做静默截断 */
export const STITCH_MAX_HEIGHT = 20000

/** 重叠校验的列采样数（行数很大时仍保持低开销） */
const SAMPLE_COLUMNS = 32

/** 采样列的通道容差，容忍 PNG 编解码的 1 级舍入 */
const CHANNEL_TOLERANCE = 1

export interface StitchResult {
  buffer: Buffer
  /** 输出图片的物理像素尺寸 */
  width: number
  height: number
  /** 每一段与上一段的重叠行数（首段不参与） */
  overlaps: number[]
}

interface DecodedFrame {
  width: number
  height: number
  /** nativeImage 的原始位图（BGRA） */
  pixels: Buffer
}

function decodeFrame(frame: Buffer, index: number): DecodedFrame {
  const image = nativeImage.createFromBuffer(frame)
  if (image.isEmpty()) throw new Error(`第 ${index + 1} 段画面无法解码`)
  const { width, height } = image.getSize()
  if (width < 1 || height < 1) throw new Error(`第 ${index + 1} 段画面尺寸无效`)
  return { width, height, pixels: image.toBitmap() }
}

function columnStep(width: number): number {
  return Math.max(1, Math.floor(width / SAMPLE_COLUMNS))
}

/** 比较两帧的指定行是否一致（按列采样，最多取 32 列） */
function rowMatches(a: DecodedFrame, rowA: number, b: DecodedFrame, rowB: number, step: number): boolean {
  const stride = a.width * 4
  const aOffset = rowA * stride
  const bOffset = rowB * stride
  for (let x = 0; x < a.width; x += step) {
    const ai = aOffset + x * 4
    const bi = bOffset + x * 4
    if (
      Math.abs(a.pixels[ai] - b.pixels[bi]) > CHANNEL_TOLERANCE ||
      Math.abs(a.pixels[ai + 1] - b.pixels[bi + 1]) > CHANNEL_TOLERANCE ||
      Math.abs(a.pixels[ai + 2] - b.pixels[bi + 2]) > CHANNEL_TOLERANCE
    ) {
      return false
    }
  }
  return true
}

/**
 * 求上一帧底部与下一帧顶部的最大重叠行数。
 * 先抽 3 行粗筛，命中后再逐行采样校验，避免 O(高度²)。
 */
function overlapRows(previous: DecodedFrame, next: DecodedFrame): number {
  const max = Math.min(previous.height, next.height)
  const step = columnStep(previous.width)
  for (let k = max; k >= 1; k -= 1) {
    const probes = [0, Math.floor((k - 1) / 2), k - 1]
    const coarse = probes.every((offset) =>
      rowMatches(previous, previous.height - k + offset, next, offset, step),
    )
    if (!coarse) continue
    for (let row = 0; row < k; row += 1) {
      if (!rowMatches(previous, previous.height - k + row, next, row, step)) return 0
    }
    return k
  }
  return 0
}

/**
 * 把同一固定选区的连续截图纵向拼接。
 * 有重叠时只保留新增内容；找不到重叠时整帧追加（用户滚动幅度大于一屏会产生缝隙）。
 */
export function stitchVertical(frames: Buffer[], maxHeight = STITCH_MAX_HEIGHT): StitchResult {
  if (frames.length === 0) throw new Error('长截图没有可拼接的画面')

  const first = decodeFrame(frames[0], 0)
  if (first.height > maxHeight) throw heightLimitError(maxHeight)

  const pieces: Buffer[] = [first.pixels]
  let width = first.width
  let totalHeight = first.height
  let previous = first
  const overlaps: number[] = []

  for (let index = 1; index < frames.length; index += 1) {
    const current = decodeFrame(frames[index], index)
    if (current.width !== width) throw new Error('长截图各段宽度不一致，请保持选区与缩放比例不变')
    const overlap = overlapRows(previous, current)
    overlaps.push(overlap)
    const stride = current.width * 4
    if (current.height > overlap) pieces.push(current.pixels.subarray(overlap * stride))
    totalHeight += current.height - overlap
    if (totalHeight > maxHeight) throw heightLimitError(maxHeight)
    previous = current
  }

  const output = Buffer.alloc(width * totalHeight * 4)
  let offset = 0
  for (const piece of pieces) {
    piece.copy(output, offset)
    offset += piece.length
  }
  const image = nativeImage.createFromBitmap(output, { width, height: totalHeight })
  if (image.isEmpty()) throw new Error('长截图拼接结果无法编码为图片')
  return { buffer: image.toPNG(), width, height: totalHeight, overlaps }
}

function heightLimitError(maxHeight: number): Error {
  return new Error(`长截图高度超过上限（${maxHeight} 物理像素），请减少采集段数`)
}
