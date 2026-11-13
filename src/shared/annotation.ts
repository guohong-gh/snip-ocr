/**
 * 标注绘制内核：贴图窗直接 import，遮罩注入脚本通过 `toString()` 注入。
 * 因此这里导出的 `createAnnotationStroke` / `appendAnnotationPoint` / `renderAnnotations`
 * 必须自包含，不能引用本模块其它绑定（类型在编译后会被擦除，不受影响）。
 */

/** 三种可选颜色；只允许红/黄/蓝 */
export const ANNOTATION_COLORS = {
  red: '#e5484d',
  yellow: '#f5c518',
  blue: '#2f6fed',
} as const

export type AnnotationColor = keyof typeof ANNOTATION_COLORS

export const ANNOTATION_COLOR_ORDER: AnnotationColor[] = ['red', 'yellow', 'blue']

export const ANNOTATION_COLOR_LABELS: Record<AnnotationColor, string> = {
  red: '红色',
  yellow: '黄色',
  blue: '蓝色',
}

export const ANNOTATION_TOOLS = ['pen', 'rect', 'ellipse'] as const

export type AnnotationTool = (typeof ANNOTATION_TOOLS)[number]

export const ANNOTATION_TOOL_LABELS: Record<AnnotationTool, string> = {
  pen: '画笔',
  rect: '方框',
  ellipse: '圆形',
}

/** 画笔基础线宽（CSS px，绘制时按所在画布宽度换算成比例存储） */
export const ANNOTATION_STROKE_WIDTH = 3

export interface AnnotationPoint {
  /** 归一化横坐标 0..1 */
  x: number
  /** 归一化纵坐标 0..1 */
  y: number
}

export interface AnnotationStroke {
  tool: AnnotationTool
  /** 十六进制颜色（来自 ANNOTATION_COLORS） */
  color: string
  /** 线宽占画布宽度的比例，渲染时乘以目标宽度 */
  width: number
  /** 归一化坐标；画笔为折线点，方框/圆形为起点与终点 */
  points: AnnotationPoint[]
}

/** 只声明渲染真正用到的成员，便于主进程测试用 mock context */
export interface AnnotationDrawContext {
  save(): void
  restore(): void
  beginPath(): void
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  stroke(): void
  rect(x: number, y: number, width: number, height: number): void
  ellipse(
    x: number,
    y: number,
    radiusX: number,
    radiusY: number,
    rotation: number,
    startAngle: number,
    endAngle: number,
  ): void
  lineWidth: number
  lineCap: string
  lineJoin: string
  strokeStyle: string | object
}

export function clampAnnotationPoint(x: number, y: number): AnnotationPoint {
  return {
    x: Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0)),
    y: Math.max(0, Math.min(1, Number.isFinite(y) ? y : 0)),
  }
}

export function normalizeAnnotationPoint(
  x: number,
  y: number,
  width: number,
  height: number,
): AnnotationPoint {
  const safeWidth = width > 0 ? width : 1
  const safeHeight = height > 0 ? height : 1
  return clampAnnotationPoint(x / safeWidth, y / safeHeight)
}

/** 新建一笔；color 传十六进制值，避免注入时依赖颜色表 */
export function createAnnotationStroke(
  tool: AnnotationTool,
  color: string,
  surfaceWidth: number,
  point: AnnotationPoint,
  widthPx: number,
): AnnotationStroke {
  const width = Math.max(0.5, widthPx) / Math.max(1, surfaceWidth)
  // 自包含：不能调用模块内其它函数，否则 toString() 注入后会丢失绑定
  const start = {
    x: Math.max(0, Math.min(1, Number.isFinite(point.x) ? point.x : 0)),
    y: Math.max(0, Math.min(1, Number.isFinite(point.y) ? point.y : 0)),
  }
  return {
    tool,
    color,
    width,
    points: tool === 'pen' ? [start] : [start, { x: start.x, y: start.y }],
  }
}

/** 画笔追加折点；方框/圆形只更新终点 */
export function appendAnnotationPoint(stroke: AnnotationStroke, point: AnnotationPoint): void {
  // 自包含：不能调用模块内其它函数，否则 toString() 注入后会丢失绑定
  const next = {
    x: Math.max(0, Math.min(1, Number.isFinite(point.x) ? point.x : 0)),
    y: Math.max(0, Math.min(1, Number.isFinite(point.y) ? point.y : 0)),
  }
  if (stroke.tool === 'pen') {
    stroke.points.push(next)
    return
  }
  if (stroke.points.length > 1) stroke.points[1] = next
  else stroke.points.push(next)
}

/** 笔迹的归一化包围盒 */
export function annotationBounds(stroke: AnnotationStroke): {
  x: number
  y: number
  width: number
  height: number
} {
  let minX = 1
  let minY = 1
  let maxX = 0
  let maxY = 0
  for (const point of stroke.points) {
    if (point.x < minX) minX = point.x
    if (point.y < minY) minY = point.y
    if (point.x > maxX) maxX = point.x
    if (point.y > maxY) maxY = point.y
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= 0) return Math.hypot(px - ax, py - ay)
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t))
}

/**
 * 命中测试：point 与 width/height 使用像素坐标。
 * 画笔命中折线，方框命中四条边，圆形命中椭圆轮廓；容差已包含线宽。
 */
export function isPointOnAnnotation(
  stroke: AnnotationStroke,
  x: number,
  y: number,
  width: number,
  height: number,
  tolerance = 5,
): boolean {
  if (stroke.points.length === 0) return false
  const hitRange = Math.max(1, stroke.width * width) / 2 + Math.max(0, tolerance)
  const toPixel = (point: AnnotationPoint): { x: number; y: number } => ({
    x: point.x * width,
    y: point.y * height,
  })
  if (stroke.tool === 'pen') {
    const points = stroke.points.map(toPixel)
    if (points.length === 1) return Math.hypot(x - points[0].x, y - points[0].y) <= hitRange
    for (let index = 1; index < points.length; index += 1) {
      const a = points[index - 1]
      const b = points[index]
      if (distanceToSegment(x, y, a.x, a.y, b.x, b.y) <= hitRange) return true
    }
    return false
  }
  const start = toPixel(stroke.points[0])
  const end = toPixel(stroke.points.length > 1 ? stroke.points[1] : stroke.points[0])
  const left = Math.min(start.x, end.x)
  const right = Math.max(start.x, end.x)
  const top = Math.min(start.y, end.y)
  const bottom = Math.max(start.y, end.y)
  if (stroke.tool === 'rect') {
    return (
      distanceToSegment(x, y, left, top, right, top) <= hitRange ||
      distanceToSegment(x, y, right, top, right, bottom) <= hitRange ||
      distanceToSegment(x, y, right, bottom, left, bottom) <= hitRange ||
      distanceToSegment(x, y, left, bottom, left, top) <= hitRange
    )
  }
  const radiusX = Math.max(0.5, (right - left) / 2)
  const radiusY = Math.max(0.5, (bottom - top) / 2)
  const centerX = (left + right) / 2
  const centerY = (top + bottom) / 2
  const steps = 96
  let previous = { x: centerX + radiusX, y: centerY }
  for (let index = 1; index <= steps; index += 1) {
    const angle = (Math.PI * 2 * index) / steps
    const current = {
      x: centerX + radiusX * Math.cos(angle),
      y: centerY + radiusY * Math.sin(angle),
    }
    if (distanceToSegment(x, y, previous.x, previous.y, current.x, current.y) <= hitRange) return true
    previous = current
  }
  return false
}

/** 把笔迹栅格化到 width × height 的画布；自包含，供注入脚本与贴图窗共用 */
export function renderAnnotations(
  ctx: AnnotationDrawContext,
  strokes: readonly AnnotationStroke[],
  width: number,
  height: number,
): void {
  if (!strokes || strokes.length === 0 || width < 1 || height < 1) return
  ctx.save()
  for (const stroke of strokes) {
    if (!stroke || !stroke.points || stroke.points.length === 0) continue
    ctx.lineWidth = Math.max(0.5, stroke.width * width)
    ctx.strokeStyle = stroke.color
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    const start = stroke.points[0]
    if (stroke.tool === 'pen') {
      ctx.moveTo(start.x * width, start.y * height)
      for (let index = 1; index < stroke.points.length; index += 1) {
        const point = stroke.points[index]
        ctx.lineTo(point.x * width, point.y * height)
      }
      // 单点也不能完全不可见
      if (stroke.points.length === 1) ctx.lineTo(start.x * width + 0.01, start.y * height)
      ctx.stroke()
      continue
    }
    const end = stroke.points.length > 1 ? stroke.points[1] : start
    const left = Math.min(start.x, end.x) * width
    const top = Math.min(start.y, end.y) * height
    const boxWidth = Math.abs(end.x - start.x) * width
    const boxHeight = Math.abs(end.y - start.y) * height
    if (boxWidth < 0.5 && boxHeight < 0.5) continue
    if (stroke.tool === 'rect') {
      ctx.rect(left, top, Math.max(0.5, boxWidth), Math.max(0.5, boxHeight))
    } else {
      ctx.ellipse(
        left + boxWidth / 2,
        top + boxHeight / 2,
        Math.max(0.25, boxWidth / 2),
        Math.max(0.25, boxHeight / 2),
        0,
        0,
        Math.PI * 2,
      )
    }
    ctx.stroke()
  }
  ctx.restore()
}
