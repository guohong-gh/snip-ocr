import { nativeImage } from 'electron'

/** 单段最大高度（物理像素），超出后按段导出，不再整图失败 */
export const STITCH_MAX_HEIGHT = 20000

/** 整行指纹的采样列数 */
const ROW_SAMPLES = 32

/** 左右两侧屏蔽宽度比例（滚动条、固定侧栏） */
const SIDE_MARGIN_RATIO = 0.04

/** 运动检测网格 */
const FP_COLS = 24
const FP_ROWS = 16
/** 单格灰度差超过此值视为该格变化 */
export const FRAME_CELL_DELTA = 12
/** 变化格子占比超过此值视为画面已变化（过滤闪烁光标、悬停动画、滚动条） */
export const FRAME_CHANGED_RATIO = 0.04

/** 固定表头最多占画面高度的比例 */
const STICKY_MAX_RATIO = 0.12
/** 固定表头逐行判等容差 */
const STICKY_ROW_TOLERANCE = 8
/** 固定表头带的最小行数 */
const STICKY_MIN_ROWS = 3
/** 固定表头带的最小对比度，避免把顶部空白误判为表头 */
const STICKY_MIN_CONTRAST = 24

/** 重叠候选粗筛的行容差 */
const OVERLAP_PROBE_LIMIT = 60
/** 重叠候选可接受的平均灰度差 */
const OVERLAP_MAX_MEAN_DIFF = 26
/** 单行判为一致的灰度差 */
const OVERLAP_ROW_MATCH_TOLERANCE = 20
/** 重叠候选可接受的行一致比例 */
const OVERLAP_MIN_MATCH_RATIO = 0.72
/** 最小重叠行数 */
const OVERLAP_MIN_ROWS = 8
/** 精算重叠时最多采样的行数 */
const OVERLAP_SCORE_ROWS = 40

/** 低分辨率指纹：每格平均灰度（行优先），用于运动检测与「到底」判定 */
export interface FrameFingerprint {
  cols: number
  rows: number
  values: Uint8Array
}

interface RowSignatures {
  height: number
  /** height × ROW_SAMPLES 的灰度值 */
  values: Uint8Array
}

/** 供长图跟随阶段做增量重叠计算（与 stitchVertical 使用同一套指纹） */
export type { RowSignatures }

export interface StitchSegment {
  buffer: Buffer
  height: number
}

export interface StitchResult {
  /** 第一段；未超过上限时即完整拼接图 */
  buffer: Buffer
  width: number
  /** 拼接总高度，可能超过 STITCH_MAX_HEIGHT */
  height: number
  /** 每一段与上一段的重叠行数（首段不参与） */
  overlaps: number[]
  /** 分段结果，每段高度 ≤ maxHeight */
  segments: StitchSegment[]
}

interface DecodedFrame {
  width: number
  height: number
  /** nativeImage 原始位图（BGRA） */
  pixels: Buffer
}

/** 从原始位图算低分辨率指纹；滚动跟随用它做运动检测 */
export function fingerprintPixels(pixels: Buffer, width: number, height: number): FrameFingerprint {
  const values = new Uint8Array(FP_COLS * FP_ROWS)
  const marginX = Math.floor(width * SIDE_MARGIN_RATIO)
  const usable = Math.max(1, width - marginX * 2)
  const stride = width * 4
  const cellW = usable / FP_COLS
  const cellH = height / FP_ROWS
  for (let row = 0; row < FP_ROWS; row += 1) {
    const y0 = Math.floor(row * cellH)
    const y1 = Math.min(height, Math.max(y0 + 1, Math.floor((row + 1) * cellH)))
    for (let col = 0; col < FP_COLS; col += 1) {
      const x0 = marginX + Math.floor(col * cellW)
      const x1 = Math.min(marginX + usable, Math.max(x0 + 1, Math.floor((col + 1) * cellW)))
      let sum = 0
      let count = 0
      for (let sy = 0; sy < 3; sy += 1) {
        const y = Math.min(height - 1, y0 + Math.floor(((y1 - y0) * (sy + 1)) / 4))
        for (let sx = 0; sx < 3; sx += 1) {
          const x = Math.min(width - 1, x0 + Math.floor(((x1 - x0) * (sx + 1)) / 4))
          const offset = y * stride + x * 4
          sum += (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / 3
          count += 1
        }
      }
      values[row * FP_COLS + col] = Math.round(sum / count)
    }
  }
  return { cols: FP_COLS, rows: FP_ROWS, values }
}

/** 两张指纹是否「同一画面」：只允许少量格子变化（光标/动画/滚动条） */
export function framesLookSame(a: FrameFingerprint, b: FrameFingerprint): boolean {
  if (a.cols !== b.cols || a.rows !== b.rows || a.values.length !== b.values.length) return false
  let changed = 0
  for (let i = 0; i < a.values.length; i += 1) {
    if (Math.abs(a.values[i] - b.values[i]) > FRAME_CELL_DELTA) changed += 1
  }
  return changed / a.values.length <= FRAME_CHANGED_RATIO
}

function decodeFrame(frame: Buffer, index: number): DecodedFrame {
  const image = nativeImage.createFromBuffer(frame)
  if (image.isEmpty()) throw new Error(`第 ${index + 1} 段画面无法解码`)
  const { width, height } = image.getSize()
  if (width < 1 || height < 1) throw new Error(`第 ${index + 1} 段画面尺寸无效`)
  return { width, height, pixels: image.toBitmap() }
}

export function buildRowSignatures(pixels: Buffer, width: number, height: number): RowSignatures {
  const marginX = Math.floor(width * SIDE_MARGIN_RATIO)
  const usable = Math.max(1, width - marginX * 2)
  const stride = width * 4
  const values = new Uint8Array(height * ROW_SAMPLES)
  for (let row = 0; row < height; row += 1) {
    const base = row * stride
    for (let sample = 0; sample < ROW_SAMPLES; sample += 1) {
      const x = marginX + Math.min(usable - 1, Math.floor((usable * (sample + 0.5)) / ROW_SAMPLES))
      const offset = base + x * 4
      values[row * ROW_SAMPLES + sample] = Math.round(
        (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / 3,
      )
    }
  }
  return { height, values }
}

/** 逐行灰度指纹的平均绝对差（0–255） */
function rowMeanDiff(a: RowSignatures, rowA: number, b: RowSignatures, rowB: number): number {
  const offsetA = rowA * ROW_SAMPLES
  const offsetB = rowB * ROW_SAMPLES
  let sum = 0
  for (let i = 0; i < ROW_SAMPLES; i += 1) sum += Math.abs(a.values[offsetA + i] - b.values[offsetB + i])
  return sum / ROW_SAMPLES
}

/** 顶部连续一致且有明显内容的行数，即固定表头高度 */
export function detectStickyRows(reference: RowSignatures, current: RowSignatures): number {
  const limit = Math.floor(Math.min(reference.height, current.height) * STICKY_MAX_RATIO)
  if (limit < STICKY_MIN_ROWS) return 0
  let rows = 0
  while (rows < limit && rowMeanDiff(reference, rows, current, rows) <= STICKY_ROW_TOLERANCE) rows += 1
  if (rows < STICKY_MIN_ROWS) return 0
  let min = 255
  let max = 0
  for (let row = 0; row < rows; row += 1) {
    for (let sample = 0; sample < ROW_SAMPLES; sample += 1) {
      const value = reference.values[row * ROW_SAMPLES + sample]
      if (value < min) min = value
      if (value > max) max = value
    }
  }
  return max - min >= STICKY_MIN_CONTRAST ? rows : 0
}

function scoreOverlap(
  previous: RowSignatures,
  next: RowSignatures,
  overlap: number,
  nextTop: number,
): { mean: number; ratio: number } {
  const step = Math.max(1, Math.ceil(overlap / OVERLAP_SCORE_ROWS))
  let rows = 0
  let total = 0
  let matched = 0
  for (let offset = 0; offset < overlap; offset += step) {
    const diff = rowMeanDiff(previous, previous.height - overlap + offset, next, nextTop + offset)
    total += diff
    rows += 1
    if (diff <= OVERLAP_ROW_MATCH_TOLERANCE) matched += 1
  }
  if (rows === 0) return { mean: 255, ratio: 0 }
  return { mean: total / rows, ratio: matched / rows }
}

/**
 * 在候选重叠行数里打分取最优（整行灰度指纹，容忍压缩/平滑滚动带来的小幅差异）。
 * nextTop 是需要从下一帧头部跳过的固定表头行数。
 */
export function matchOverlap(previous: RowSignatures, next: RowSignatures, nextTop: number): number {
  const maxK = Math.min(previous.height, next.height - nextTop)
  if (maxK < OVERLAP_MIN_ROWS) return 0
  let bestK = 0
  let bestScore = Number.POSITIVE_INFINITY
  for (let k = maxK; k >= OVERLAP_MIN_ROWS; k -= 1) {
    const probes = [0, Math.floor(k / 3), Math.floor((k * 2) / 3), k - 1]
    let coarse = true
    for (const offset of probes) {
      if (rowMeanDiff(previous, previous.height - k + offset, next, nextTop + offset) > OVERLAP_PROBE_LIMIT) {
        coarse = false
        break
      }
    }
    if (!coarse) continue
    const { mean, ratio } = scoreOverlap(previous, next, k, nextTop)
    if (ratio < OVERLAP_MIN_MATCH_RATIO || mean > OVERLAP_MAX_MEAN_DIFF) continue
    if (mean < bestScore || (mean === bestScore && k > bestK)) {
      bestScore = mean
      bestK = k
    }
  }
  return bestK
}

/**
 * 把同一固定选区的连续截图纵向拼接。
 * 用整行指纹多候选打分找重叠；固定表头只保留首帧的一份；
 * 总高度超过上限时按 maxHeight 分段导出，不丢帧也不抛错。
 */
export function stitchVertical(frames: Buffer[], maxHeight = STITCH_MAX_HEIGHT): StitchResult {
  if (frames.length === 0) throw new Error('长截图没有可拼接的画面')

  const decoded = frames.map((frame, index) => decodeFrame(frame, index))
  const width = decoded[0].width
  for (const frame of decoded) {
    if (frame.width !== width) throw new Error('长截图各段宽度不一致，请保持选区与缩放比例不变')
  }

  const signatures = decoded.map((frame) => buildRowSignatures(frame.pixels, frame.width, frame.height))
  const pieces: { pixels: Buffer; rows: number }[] = [{ pixels: decoded[0].pixels, rows: decoded[0].height }]
  const overlaps: number[] = []

  for (let index = 1; index < decoded.length; index += 1) {
    const nextTop = detectStickyRows(signatures[0], signatures[index])
    const overlap = matchOverlap(signatures[index - 1], signatures[index], nextTop)
    overlaps.push(overlap)
    const startRow = nextTop + overlap
    if (startRow < decoded[index].height) {
      pieces.push({
        pixels: decoded[index].pixels.subarray(startRow * decoded[index].width * 4),
        rows: decoded[index].height - startRow,
      })
    }
  }

  const totalHeight = pieces.reduce((total, piece) => total + piece.rows, 0)
  const segments: StitchSegment[] = []
  for (let start = 0; start < totalHeight; start += maxHeight) {
    const rows = Math.min(maxHeight, totalHeight - start)
    const output = Buffer.alloc(width * rows * 4)
    let destination = 0
    let cursor = 0
    for (const piece of pieces) {
      const pieceStart = cursor
      const pieceEnd = cursor + piece.rows
      cursor = pieceEnd
      if (pieceEnd <= start || pieceStart >= start + rows) continue
      const from = Math.max(start, pieceStart)
      const to = Math.min(start + rows, pieceEnd)
      const sourceOffset = (from - pieceStart) * width * 4
      const length = (to - from) * width * 4
      piece.pixels.copy(output, destination, sourceOffset, sourceOffset + length)
      destination += length
    }
    const image = nativeImage.createFromBitmap(output, { width, height: rows })
    if (image.isEmpty()) throw new Error('长截图拼接结果无法编码为图片')
    segments.push({ buffer: image.toPNG(), height: rows })
  }

  return { buffer: segments[0].buffer, width, height: totalHeight, overlaps, segments }
}
