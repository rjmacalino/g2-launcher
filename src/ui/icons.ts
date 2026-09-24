import { ICON_SIZE } from './tokens'
import type { WeatherCondition } from '../features/weather/conditions'

// Flat, high-contrast, edge-to-edge shapes, following the official icon
// workflow in docs/platform.md's design guidelines section: a single
// recognisable silhouette, no gradients or anti-aliasing, strokes at least
// 2px wide at final size. Drawn directly at ICON_SIZE (24 x 24) rather than
// drawn large and scaled down - simple enough shapes that drawing at native
// size and thresholding the result is the whole "clean up by hand" step the
// guidelines describe, just done in code instead of by hand in an editor.
//
// White = lit (drawn on the glasses), black = off, matching how the test
// pattern in features/lab/test-pattern.ts already established black reads
// as background on this display.
function threshold(ctx: CanvasRenderingContext2D, size: number) {
  const img = ctx.getImageData(0, 0, size, size)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const luminance = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
    const v = luminance > 128 ? 255 : 0
    d[i] = v
    d[i + 1] = v
    d[i + 2] = v
    d[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
}

function newCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = ICON_SIZE
  canvas.height = ICON_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d canvas context unavailable')
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, ICON_SIZE, ICON_SIZE)
  ctx.fillStyle = '#ffffff'
  ctx.strokeStyle = '#ffffff'
  return { canvas, ctx }
}

async function toPng(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
): Promise<Uint8Array> {
  threshold(ctx, ICON_SIZE)
  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
  })
  return new Uint8Array(await blob.arrayBuffer())
}

// Overlapping filled circles - the standard cloud silhouette, simple enough
// to stay recognisable after the threshold pass.
function drawCloud(ctx: CanvasRenderingContext2D, cx: number, cy: number, scale: number) {
  ctx.beginPath()
  ctx.arc(cx - 5 * scale, cy + 1 * scale, 4.5 * scale, 0, Math.PI * 2)
  ctx.arc(cx, cy - 2 * scale, 5.5 * scale, 0, Math.PI * 2)
  ctx.arc(cx + 5 * scale, cy + 1 * scale, 4.5 * scale, 0, Math.PI * 2)
  ctx.rect(cx - 8 * scale, cy + 1 * scale, 16 * scale, 5 * scale)
  ctx.fill()
}

function drawSun(ctx: CanvasRenderingContext2D) {
  const c = ICON_SIZE / 2
  ctx.beginPath()
  ctx.arc(c, c, 8, 0, Math.PI * 2)
  ctx.fill()
  ctx.lineWidth = 2.5
  const rays = 8
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2
    const x1 = c + Math.cos(a) * 9
    const y1 = c + Math.sin(a) * 9
    const x2 = c + Math.cos(a) * 12
    const y2 = c + Math.sin(a) * 12
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
  }
}

function drawCloudy(ctx: CanvasRenderingContext2D) {
  drawCloud(ctx, ICON_SIZE / 2, ICON_SIZE / 2, 1)
}

function drawRainDrops(ctx: CanvasRenderingContext2D, count: number) {
  ctx.lineWidth = 2.5
  ctx.lineCap = 'round'
  const startY = 17
  const spacing = ICON_SIZE / (count + 1)
  for (let i = 1; i <= count; i++) {
    const x = spacing * i
    ctx.beginPath()
    ctx.moveTo(x, startY)
    ctx.lineTo(x - 2, startY + 4)
    ctx.stroke()
  }
}

function drawRain(ctx: CanvasRenderingContext2D) {
  drawCloud(ctx, ICON_SIZE / 2, 8, 0.85)
  drawRainDrops(ctx, 3)
}

function drawSnow(ctx: CanvasRenderingContext2D) {
  drawCloud(ctx, ICON_SIZE / 2, 8, 0.85)
  const positions = [7, 12, 17]
  for (const x of positions) {
    ctx.beginPath()
    ctx.arc(x, 19, 1.6, 0, Math.PI * 2)
    ctx.fill()
  }
}

function drawFog(ctx: CanvasRenderingContext2D) {
  ctx.lineWidth = 3
  ctx.lineCap = 'round'
  const rows = [6, 12, 18]
  for (const y of rows) {
    ctx.beginPath()
    ctx.moveTo(3, y)
    ctx.lineTo(ICON_SIZE - 3, y)
    ctx.stroke()
  }
}

function drawStorm(ctx: CanvasRenderingContext2D) {
  drawCloud(ctx, ICON_SIZE / 2, 7, 0.8)
  ctx.beginPath()
  ctx.moveTo(14, 13)
  ctx.lineTo(9, 20)
  ctx.lineTo(12, 20)
  ctx.lineTo(9, 24)
  ctx.lineTo(16, 16)
  ctx.lineTo(13, 16)
  ctx.closePath()
  ctx.fill()
}

const DRAWERS: Record<WeatherCondition, (ctx: CanvasRenderingContext2D) => void> = {
  clear: drawSun,
  cloudy: drawCloudy,
  rain: drawRain,
  snow: drawSnow,
  fog: drawFog,
  storm: drawStorm,
}

export async function drawWeatherIcon(condition: WeatherCondition): Promise<Uint8Array> {
  const { canvas, ctx } = newCanvas()
  DRAWERS[condition](ctx)
  return toPng(canvas, ctx)
}

export const WEATHER_ICON_CONDITIONS: readonly WeatherCondition[] = [
  'clear',
  'cloudy',
  'rain',
  'snow',
  'fog',
  'storm',
]
