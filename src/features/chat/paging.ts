import { CANVAS_WIDTH, CONTENT_HEIGHT, PADDING, ROW_HEIGHT_PX } from '../../platform/page'
import { getTextWidth } from '../../platform/text'

// Lays text out into pages so an answer of any length can be shown in full
// (see features/chat/tool.ts for why one screen update cannot simply carry
// it all). Pure - no I/O, no SDK - so it can be tested against the real
// LVGL-matching font measurement (tests/chat-paging.test.ts).
//
// Each page is about two screens tall and scrolls natively and smoothly,
// the way a single long text always did here; a page only changes when the
// wearer swipes past its end. Per direct report: one-screen pages, where
// every swipe turned the page, made it easy to lose track of which sentence
// you were reading. The firmware scrolls overflowing text itself and only
// reports a swipe that reaches the top or bottom edge (even-g2-notes,
// docs/input-events.md: "Emitted when internal scroll reaches the bottom
// boundary") - which is what lets a page change happen only at its ends.
//
// Line breaks are decided here rather than left to the firmware: every
// line is measured to fit innerWidth and ends in an explicit newline, so
// the firmware never has to wrap anything itself and a page's row count
// here is exactly what it shows.

// The glasses content area (see platform/page.ts): full canvas width and
// CONTENT_HEIGHT tall, minus the container's own padding on each side. The
// extra 8px off the width is a safety margin, so a line measured right at
// the edge can never be wrapped again by the firmware.
export const PAGE_INNER_WIDTH = CANVAS_WIDTH - 2 * PADDING - 8
// Rows visible on one screen.
export const SCREEN_ROWS = Math.floor((CONTENT_HEIGHT - 2 * PADDING) / ROW_HEIGHT_PX)
// Rows of text per page - two screens, minus the row kept for the "(2/5)"
// indicator on a multi-page answer.
export const PAGE_TEXT_ROWS = 2 * SCREEN_ROWS - 1
// A page is shown by an in-place update (2000-character firmware ceiling)
// and also by a full rebuild - after "No" on the leave prompt, or opening a
// saved conversation - whose ceiling is 1000 (docs/platform.md). Every page
// stays under the stricter one, indicator included.
export const PAGE_MAX_CHARS = 900
// The last lines of a page, repeated at the top of the next one, so the
// eye lands on text it just read rather than on a cold start.
export const OVERLAP_ROWS = 2

// Room kept for the indicator row within PAGE_MAX_CHARS.
const HINT_RESERVE_CHARS = 40

// Splits one too-wide word (a URL, a long number) into pieces that fit.
function breakLongWord(word: string, innerWidth: number): string[] {
  const pieces: string[] = []
  let rest = word
  while (getTextWidth(rest) > innerWidth) {
    let cut = rest.length - 1
    while (cut > 1 && getTextWidth(rest.slice(0, cut)) > innerWidth) cut--
    pieces.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  pieces.push(rest)
  return pieces
}

export function wrapLines(text: string, innerWidth: number): string[] {
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(' ')) {
      if (word === '') continue
      const candidate = line === '' ? word : `${line} ${word}`
      if (getTextWidth(candidate) <= innerWidth) {
        line = candidate
        continue
      }
      if (line !== '') lines.push(line)
      const pieces = breakLongWord(word, innerWidth)
      lines.push(...pieces.slice(0, -1))
      line = pieces[pieces.length - 1]
    }
    lines.push(line)
  }
  return lines
}

// The last OVERLAP_ROWS non-blank lines of a page, to carry onto the next.
function overlapFrom(page: string[]): string[] {
  let end = page.length
  while (end > 0 && page[end - 1] === '') end--
  return page.slice(Math.max(0, end - OVERLAP_ROWS), end)
}

export type Page = {
  text: string
  // Whether the whole page is visible at once, with nothing to scroll -
  // features/chat/tool.ts turns such a page on the first swipe past it,
  // since there is nothing more on it left to read.
  fitsOneScreen: boolean
}

export function paginate(text: string, innerWidth: number): Page[] {
  const lines = wrapLines(text, innerWidth)
  const chunks: { lines: string[]; overlap: number }[] = []
  let next = 0
  while (next < lines.length) {
    // A page never starts its new text on a blank line.
    while (next < lines.length && lines[next] === '') next++
    if (next >= lines.length) break
    const previous = chunks[chunks.length - 1]
    const carried = previous ? overlapFrom(previous.lines) : []
    const page = [...carried]
    let chars = page.join('\n').length
    const budget = PAGE_MAX_CHARS - HINT_RESERVE_CHARS
    while (next < lines.length && page.length < PAGE_TEXT_ROWS) {
      const added = (page.length > 0 ? 1 : 0) + lines[next].length
      // Always take at least one new line, so paging always moves forward.
      if (page.length > carried.length && chars + added > budget) break
      page.push(lines[next])
      chars += added
      next++
    }
    chunks.push({ lines: page, overlap: carried.length })
  }

  if (chunks.length <= 1) {
    const only = (chunks[0]?.lines ?? []).join('\n')
    return [{ text: only, fitsOneScreen: (chunks[0]?.lines.length ?? 0) <= SCREEN_ROWS }]
  }
  return chunks.map((chunk, i) => {
    const position = `${i + 1}/${chunks.length}`
    const hint =
      i < chunks.length - 1 ? `(${position} - keep swiping down for more)` : `(${position})`
    const rows = [...chunk.lines, hint]
    return { text: rows.join('\n'), fitsOneScreen: rows.length <= SCREEN_ROWS }
  })
}
