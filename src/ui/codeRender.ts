import { codeFontStack, isCodeFontLoaded } from './codeFont'
import { CANVAS_WIDTH, CONTENT_HEIGHT, TILE_COUNT, TILE_HEIGHT, TILE_WIDTH } from '../platform/page'

// Code drawn as pictures for the glasses (G2-73). The glasses' own text has
// one built-in proportional font and no size control (docs/platform.md),
// which scrambles code's alignment. Images have no such limit: code is
// drawn here on a canvas in a real monospace font, at a size the wearer
// picks, and sent as the four tiles of a 'tiles' page (platform/page.ts).
// White on black: the glasses show white as their brightest green and
// black as off.

// 75% of the first sizes (16/19/23), at RJ's request: code read as large as
// the text, and more of it fits per screen this way.
// One size (G2-93): the smallest was very readable on the glasses, so the
// size choice went and long press was freed.
export const CODE_FONT_PX = 12

const MARGIN_X = 8
const MARGIN_Y = 6
// The bottom row: where in the code this is and what the gestures do.
const FOOTER_PX = 14
const FOOTER_GAP = 6

function font(px: number): string {
  return `500 ${px}px ${codeFontStack()}`
}

export type CodeMetrics = {
  cols: number
  rows: number
  lineHeight: number
  fontPx: number
  // Measured with the bundled font, not a fallback (codeFont.ts).
  withFont: boolean
}

// How many characters and lines fit at this size, measured with the real
// font on this phone - monospace, so one character's width is everyone's.
export function codeMetrics(fontPx: number): CodeMetrics {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d canvas context unavailable')
  ctx.font = font(fontPx)
  const charWidth = ctx.measureText('M'.repeat(10)).width / 10
  const lineHeight = Math.round(fontPx * 1.3)
  const usable = CONTENT_HEIGHT - 2 * MARGIN_Y - FOOTER_PX - FOOTER_GAP
  return {
    cols: Math.max(10, Math.floor((CANVAS_WIDTH - 2 * MARGIN_X) / charWidth)),
    rows: Math.max(3, Math.floor(usable / lineHeight)),
    lineHeight,
    fontPx,
    withFont: isCodeFontLoaded(),
  }
}

async function png(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
  })
  return new Uint8Array(await blob.arrayBuffer())
}

// One screen of code plus its footer, as the four tile images in container
// order (top-left, top-right, bottom-left, bottom-right).
export async function renderCodeTiles(
  lines: string[],
  metrics: CodeMetrics,
  footer: string,
): Promise<Uint8Array[]> {
  const full = document.createElement('canvas')
  full.width = CANVAS_WIDTH
  full.height = CONTENT_HEIGHT
  const ctx = full.getContext('2d')
  if (!ctx) throw new Error('2d canvas context unavailable')
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, full.width, full.height)
  ctx.textBaseline = 'top'
  ctx.fillStyle = '#ffffff'
  ctx.font = font(metrics.fontPx)
  lines.forEach((line, i) => {
    ctx.fillText(line, MARGIN_X, MARGIN_Y + i * metrics.lineHeight)
  })
  ctx.fillStyle = '#8a8a8a'
  ctx.font = `${FOOTER_PX - 2}px sans-serif`
  ctx.fillText(footer, MARGIN_X, CONTENT_HEIGHT - MARGIN_Y - FOOTER_PX + 2)

  const tiles: Uint8Array[] = []
  for (let i = 0; i < TILE_COUNT; i++) {
    const tile = document.createElement('canvas')
    tile.width = TILE_WIDTH
    tile.height = TILE_HEIGHT
    tile
      .getContext('2d')
      ?.drawImage(
        full,
        (i % 2) * TILE_WIDTH,
        Math.floor(i / 2) * TILE_HEIGHT,
        TILE_WIDTH,
        TILE_HEIGHT,
        0,
        0,
        TILE_WIDTH,
        TILE_HEIGHT,
      )
    tiles.push(await png(tile))
  }
  return tiles
}
