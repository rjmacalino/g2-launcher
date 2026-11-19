import { getCodeSize } from '../../core/codeSize'
import { splitAnswer } from '../../shared/answerBlocks'
import { codeScreens, layoutCodeRows, type CodeRow } from '../../shared/codeLayout'
import { codeGutter, codeMetrics, renderCodeTiles, type CodeMetrics } from '../../ui/codeRender'
import { PAGE_INNER_WIDTH, fitsAsText } from './paging'

// THE CODE VIEW (G2-73), its layout and pictures (split out of tool.ts in
// G2-172; tool.ts keeps which block and screen are open). The glasses' own
// text has one proportional font, which scrambles code, so code in an
// answer is drawn as pictures instead (ui/codeRender.ts) in a real
// monospace font, at the size chosen on the phone. In the text view tall
// code stays as text with a hint under it; a tap opens the code view, a
// swipe or tap pages through it, and a double-tap returns to the text.

export type CodeLayout = {
  block: number
  screens: CodeRow[][]
  metrics: CodeMetrics
  // Pixels the line numbers take, with the gap after them (G2-117).
  gutterPx: number
}

export type CodeView = CodeLayout & { screen: number }

// An answer's text for the glasses, with a hint under each code block too
// tall for one screen (G2-121); those blocks are added to `blocks`, in
// order, for the code view.
export function withCodePlaceholders(text: string, blocks: string[]): string {
  const parts = splitAnswer(text)
  if (!parts.some(b => b.kind === 'code')) return text
  const isPicture = (b: (typeof parts)[number]) =>
    b.kind === 'code' && !fitsAsText(b.text, PAGE_INNER_WIDTH)
  const total = parts.filter(isPicture).length
  return parts
    .map(part => {
      if (!isPicture(part)) return part.text
      blocks.push(part.text)
      const n = blocks.length
      return `${part.text}\n[tap: view code${total > 1 ? ` ${n} of ${total}` : ''} as a picture]`
    })
    .join('\n\n')
}

export function layoutBlock(blocks: readonly string[], block: number): CodeLayout {
  const metrics = codeMetrics(getCodeSize())
  // The gutter holds the widest line number; the code gets what is left.
  const { gutterPx, maxPx } = codeGutter(blocks[block].split('\n').length, metrics)
  const rows = layoutCodeRows(blocks[block], maxPx, metrics.measure, metrics.cell)
  return { block, screens: codeScreens(rows, metrics.rows), metrics, gutterPx }
}

export function footerFor(blocks: readonly string[], view: CodeLayout, screen: number): string {
  // Source line numbers, as in the gutter: the first and the last that
  // start on this screen, of the block's whole count.
  const numbers = view.screens[screen].flatMap(r => (r.number === null ? [] : [r.number]))
  const first = numbers[0] ?? 1
  const last = numbers[numbers.length - 1] ?? first
  const total = blocks[view.block].split('\n').length
  const where = blocks.length > 1 ? `Code ${view.block + 1}/${blocks.length} - ` : ''
  const more = screen < view.screens.length - 1 ? 'swipe for more, ' : ''
  return `${where}lines ${first}-${last} of ${total} - ${more}hold: ask, double-tap: text`
}

// Drawing a screen of code took about 4 s on the phone (G2-91), and every
// open drew it again. Screens are kept once drawn - keyed by everything
// that changes the picture, so a new answer or size never shows a stale
// one - and drawn ahead: the first screen when an answer with code
// arrives, the next one while the wearer reads.
const TILE_CACHE_MAX = 24
const tileCache = new Map<string, Promise<Uint8Array[]>>()

export function tilesFor(
  blocks: readonly string[],
  view: CodeLayout,
  screen: number,
): Promise<Uint8Array[]> {
  const footer = footerFor(blocks, view, screen)
  const key = [view.metrics.fontPx, footer, blocks[view.block]].join('|')
  const known = tileCache.get(key)
  if (known) return known
  const drawn = renderCodeTiles(view.screens[screen], view.metrics, footer, view.gutterPx)
  drawn.catch(() => tileCache.delete(key))
  tileCache.set(key, drawn)
  if (tileCache.size > TILE_CACHE_MAX) {
    const oldest = tileCache.keys().next().value
    if (oldest !== undefined) tileCache.delete(oldest)
  }
  return drawn
}
