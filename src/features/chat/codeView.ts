import type { LongCode } from '../../shared/readingStyle'
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
// Where long code is read (G2-193, a Display setting): in the text, or only
// in the code view with one line in its place.
let longCode: LongCode = 'inline'

export function setLongCode(mode: LongCode): void {
  longCode = mode
}

// What a block in the code view is (G2-203): code, or the plain-word
// pseudocode under a "pseudo code:" label, which opens there too.
export type CodeKind = 'code' | 'pseudo'

const PSEUDO_LABEL = /(^|\n)\s*pseudo ?code:?\s*$/i
// Plain-word pseudocode is text, so it sits inside a text block after its
// label: from the line after "pseudo code:" to the next label line ("code:")
// or the block's end.
const PSEUDO_IN_TEXT =
  /(?:^|\n)[ \t]*pseudo ?code:?[ \t]*\n+([\s\S]*?)(?=\n[ \t]*\n[ \t]*[A-Za-z][A-Za-z ]{0,24}:[ \t]*(?:\n|$)|$)/gi

// Every code block of an answer, and every pseudocode block, is added to
// `blocks` (with its kind in `kinds`), in order, for the code view and its
// list (G2-203). In the text, short code and pseudocode stay as they are;
// code too tall for a screen gets a hint (G2-121), or one line instead of it
// when long code is read only in the code view (G2-193).
export function withCodePlaceholders(
  text: string,
  blocks: string[],
  kinds: CodeKind[] = [],
): string {
  const parts = splitAnswer(text)
  let pseudoNext = false
  const out = parts.map(part => {
    const pseudo = pseudoNext
    pseudoNext = part.kind === 'text' && PSEUDO_LABEL.test(part.text)
    // Pseudocode that looks like code: its own block, after the label.
    if (pseudo && part.kind === 'code') {
      blocks.push(part.text)
      kinds.push('pseudo')
      return part.text
    }
    if (part.kind !== 'code') {
      for (const found of part.text.matchAll(PSEUDO_IN_TEXT)) {
        const body = found[1].trim()
        if (body) {
          blocks.push(body)
          kinds.push('pseudo')
        }
      }
      return part.text
    }
    blocks.push(part.text)
    kinds.push('code')
    if (fitsAsText(part.text, PAGE_INNER_WIDTH)) return part.text
    const lines = part.text.split('\n').length
    // "Open in the code view" (G2-193): one line in the text instead of
    // the code, which reads better as pictures than cut into pages.
    if (longCode === 'codeView') return `[code: ${lines} lines - tap: code]`
    return `${part.text}\n[tap: view code as a picture]`
  })
  return blocks.length > 0 ? out.join('\n\n') : text
}

// The list of an answer's code view blocks (G2-203): "Pseudo code 1 (5
// lines)", "Code 1 (14 lines)", numbered by kind, in the answer's order.
export function codeBlockNames(blocks: readonly string[], kinds: readonly CodeKind[]): string[] {
  const seen = { code: 0, pseudo: 0 }
  return blocks.map((block, i) => {
    const kind = kinds[i] ?? 'code'
    seen[kind]++
    const lines = block.split('\n').length
    return `${kind === 'pseudo' ? 'Pseudo code' : 'Code'} ${seen[kind]} (${lines} lines)`
  })
}

export function layoutBlock(blocks: readonly string[], block: number): CodeLayout {
  const metrics = codeMetrics(getCodeSize())
  // The gutter holds the widest line number; the code gets what is left.
  const { gutterPx, maxPx } = codeGutter(blocks[block].split('\n').length, metrics)
  const rows = layoutCodeRows(blocks[block], maxPx, metrics.measure, metrics.cell)
  return { block, screens: codeScreens(rows, metrics.rows), metrics, gutterPx }
}

export function footerFor(
  blocks: readonly string[],
  view: CodeLayout,
  screen: number,
  kinds: readonly CodeKind[] = [],
): string {
  // Source line numbers, as in the gutter: the first and the last that
  // start on this screen, of the block's whole count.
  const numbers = view.screens[screen].flatMap(r => (r.number === null ? [] : [r.number]))
  const first = numbers[0] ?? 1
  const last = numbers[numbers.length - 1] ?? first
  const total = blocks[view.block].split('\n').length
  // Which block, by its kind and number (G2-203): "Pseudo code 1".
  const name = codeBlockNames(blocks, kinds)[view.block]?.replace(/ \(.*\)$/, '')
  const where = blocks.length > 1 && name ? `${name} - ` : ''
  const more = screen < view.screens.length - 1 ? 'swipe for more, ' : ''
  return `${where}lines ${first}-${last} of ${total} - ${more}double-tap: text`
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
  kinds: readonly CodeKind[] = [],
): Promise<Uint8Array[]> {
  const footer = footerFor(blocks, view, screen, kinds)
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
