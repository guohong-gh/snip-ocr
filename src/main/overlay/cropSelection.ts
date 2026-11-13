/// <reference lib="dom" />
/**
 * 裁剪选区脚本片段。
 * 通过 `Function.prototype.toString()` 序列化后注入遮罩页，因此函数体必须自包含。
 */

interface SnipPageWindow extends Window {
  __snipCropSelection?: (options?: { annotations?: boolean }) => string | null
  __snipAnnotRenderInto?: (
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
  ) => void
}

export function installCropSelection(): void {
  const page = window as SnipPageWindow
  page.__snipCropSelection = (options) => {
    const image = document.querySelector('.screenshots-background-image')
    const canvas = document.querySelector('.screenshots-canvas')
    if (!(image instanceof HTMLImageElement) || !canvas) return null
    const bg = image.getBoundingClientRect()
    const rect = canvas.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2 || bg.width < 1 || bg.height < 1) return null
    const scaleX = image.naturalWidth / bg.width
    const scaleY = image.naturalHeight / bg.height
    const sx = Math.max(0, Math.round((rect.left - bg.left) * scaleX))
    const sy = Math.max(0, Math.round((rect.top - bg.top) * scaleY))
    const sw = Math.min(image.naturalWidth - sx, Math.round(rect.width * scaleX))
    const sh = Math.min(image.naturalHeight - sy, Math.round(rect.height * scaleY))
    if (sw < 1 || sh < 1) return null
    const output = document.createElement('canvas')
    output.width = sw
    output.height = sh
    const ctx = output.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh)
    // OCR 继续走不带笔迹的裁剪；只有复制/保存/贴图导出时才叠加标注
    if (options && options.annotations) page.__snipAnnotRenderInto?.(ctx, sw, sh)
    return output.toDataURL('image/png')
  }
}
