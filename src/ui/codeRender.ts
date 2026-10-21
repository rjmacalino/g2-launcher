import { indentUnit, type CodeRow } from '../shared/codeLayout'
import { CANVAS_WIDTH, CONTENT_HEIGHT, TILE_COUNT, TILE_HEIGHT, TILE_WIDTH } from '../platform/page'

// Code drawn as pictures for the glasses (G2-73). The glasses' own text has
// one built-in font and no size control (docs/platform.md), which cannot
// show line numbers, indent guides or a font of our choosing. Images have
// no such limit: code is drawn here on a canvas and sent as the four tiles
// of a 'tiles' page (platform/page.ts). White on black: the glasses show
// white as their brightest green and black as off.
//
// The font is the same plain sans-serif as the footer line, 12 px (G2-118):
// RJ found the bundled monospace font too thick and asked for the footer's.
// It is proportional, so indentation is counted in columns (the width of a
// digit) rather than characters, and lines are wrapped by measured width.
export const CODE_FONT_PX = 12

const MARGIN_X = 8
const MARGIN_Y = 6
// The bottom row: where in the code this is and what the gestures do.
const FOOTER_PX = 14
const FOOTER_GAP = 6

function font(px: number): string {
  return `${px}px sans-serif`
}

// Greys on the green display (white is its brightest level, black off):
// line numbers are dim, indent guides dimmer still, so the code itself
// stays the brightest thing on screen (G2-117).
const NUMBER_COLOR = '#7a7a7a'
const GUIDE_COLOR = '#3c3c3c'

export type CodeMetrics = {
  // One indent column and one line-number digit: the width of a "0".
  cell: number
  // The width of a piece of text in this font.
  measure: (text: string) => number
  rows: number
  lineHeight: number
  fontPx: number
}

// How wide things are and how many lines fit at this size, measured with the
// real font on this phone.
export function codeMetrics(fontPx: number): CodeMetrics {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d canvas context unavailable')
  ctx.font = font(fontPx)
  const lineHeight = Math.round(fontPx * 1.3)
  const usable = CONTENT_HEIGHT - 2 * MARGIN_Y - FOOTER_PX - FOOTER_GAP
  return {
    cell: ctx.measureText('0').width,
    measure: text => ctx.measureText(text).width,
    rows: Math.max(3, Math.floor(usable / lineHeight)),
    lineHeight,
    fontPx,
  }
}

// The width the line numbers take, a gap included, and what is left for the
// code, for a block of this many lines.
export function codeGutter(
  lineCount: number,
  metrics: CodeMetrics,
): { gutterPx: number; maxPx: number } {
  const digits = Math.max(2, String(lineCount).length)
  const gutterPx = (digits + 1) * metrics.cell
  return { gutterPx, maxPx: CANVAS_WIDTH - 2 * MARGIN_X - gutterPx }
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
  rows: CodeRow[],
  metrics: CodeMetrics,
  footer: string,
  // Pixels the line numbers take, including the gap after them.
  gutterPx: number,
): Promise<Uint8Array[]> {
  const full = document.createElement('canvas')
  full.width = CANVAS_WIDTH
  full.height = CONTENT_HEIGHT
  const ctx = full.getContext('2d')
  if (!ctx) throw new Error('2d canvas context unavailable')
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, full.width, full.height)
  ctx.textBaseline = 'top'
  ctx.font = font(metrics.fontPx)
  const codeX = MARGIN_X + gutterPx
  const unit = indentUnit(rows)
  rows.forEach((row, i) => {
    const y = MARGIN_Y + i * metrics.lineHeight
    // Indent guides: one thin vertical line at each step the line is
    // indented past, running the full row height so rows join up.
    ctx.fillStyle = GUIDE_COLOR
    for (let col = 0; col < row.indent; col += unit) {
      ctx.fillRect(Math.round(codeX + col * metrics.cell), y, 1, metrics.lineHeight)
    }
    // The source line number, right-aligned in the gutter; nothing on the
    // wrapped rest of a long line.
    if (row.number !== null) {
      ctx.fillStyle = NUMBER_COLOR
      ctx.textAlign = 'right'
      ctx.fillText(String(row.number), codeX - metrics.cell, y)
      ctx.textAlign = 'left'
    }
    ctx.fillStyle = '#ffffff'
    ctx.fillText(row.text, Math.round(codeX + row.textIndent * metrics.cell), y)
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
