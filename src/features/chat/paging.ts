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
// One continuous scroll, like the Teleprompter, per direct request (code in
// particular reads badly when split): a section is as long as one in-place
// update allows (2000-character firmware ceiling, docs/platform.md), so most
// answers are a single native scroll with no breaks at all. A full rebuild
// has a stricter 1000 ceiling - see rebuildSafe below.
export const PAGE_MAX_CHARS = 1900
export const REBUILD_MAX_CHARS = 1000

// The docs allow 2000 characters in an in-place update, but the simulator
// rejects anything over 1000 (found G2-106: 930 characters went through,
// 1082 did not). Hardware has not said, so the app learns: the first time
// an update that long is rejected it calls this, and sections are split to
// the stricter size from then on. Returns false if already lowered.
let pageMaxChars = PAGE_MAX_CHARS

export function lowerPageLimit(): boolean {
  if (pageMaxChars <= REBUILD_MAX_CHARS) return false
  pageMaxChars = REBUILD_MAX_CHARS
  return true
}
// A page is up to three screens of rows (G2-116), read by scrolling smoothly
// through it; a swipe past its edge turns to the next, which starts on the
// very next line - nothing is repeated, so "75" follows "74".
export const PAGE_ROWS = SCREEN_ROWS * 3

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

// Code that fits this many rows is left as plain text in the answer
// (G2-103): a one-line declaration is not worth a picture. A screen holds
// SCREEN_ROWS rows and the question line and model name take two of them.
// Longer code becomes pictures in a code font (see tool.ts).
export const CODE_TEXT_MAX_ROWS = SCREEN_ROWS - 2

// A line's leading spaces are kept - code is unreadable without its
// indentation - and a wrapped continuation keeps the same indent. Tabs
// count as two spaces. (Found in the simulator: indented code came out
// flush left.)
export function wrapLines(text: string, innerWidth: number): string[] {
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    const paragraph = raw.replace(/\t/g, '  ')
    const indent = paragraph.slice(0, paragraph.length - paragraph.trimStart().length)
    let line = indent
    let empty = true
    for (const word of paragraph.trimStart().split(' ')) {
      if (word === '') continue
      const candidate = empty ? `${indent}${word}` : `${line} ${word}`
      if (getTextWidth(candidate) <= innerWidth) {
        line = candidate
        empty = false
        continue
      }
      if (!empty) lines.push(line)
      const pieces = breakLongWord(word, innerWidth - getTextWidth(indent))
      lines.push(...pieces.slice(0, -1).map(piece => `${indent}${piece}`))
      line = `${indent}${pieces[pieces.length - 1]}`
      empty = false
    }
    lines.push(empty ? '' : line)
  }
  return lines
}

export type RowRange = { start: number; end: number }

// The pages of a wrapped text as ranges of rows: each up to PAGE_ROWS rows
// and the character budget, the next starting on the line after the last,
// never on a blank row. Trailing blank rows are ignored.
export function pageRanges(rows: readonly string[]): RowRange[] {
  let last = rows.length
  while (last > 0 && rows[last - 1] === '') last--
  const budget = pageMaxChars - HINT_RESERVE_CHARS
  const ranges: RowRange[] = []
  let next = 0
  while (next < last) {
    while (next < last && rows[next] === '') next++
    if (next >= last) break
    const start = next
    let chars = 0
    // Always takes at least one row, so paging always moves forward.
    while (next < last && next - start < PAGE_ROWS) {
      const added = (next > start ? 1 : 0) + rows[next].length
      if (next > start && chars + added > budget) break
      chars += added
      next++
    }
    ranges.push({ start, end: next })
  }
  return ranges
}

export type Page = {
  text: string
  // Whether the whole page is visible at once, with nothing to scroll.
  fitsOneScreen: boolean
}

export function paginate(text: string, innerWidth: number): Page[] {
  const lines = wrapLines(text, innerWidth)
  const ranges = pageRanges(lines)
  if (ranges.length === 0) return [{ text: '', fitsOneScreen: true }]
  return ranges.map((range, i) => {
    const rows = lines.slice(range.start, range.end)
    const shown = i < ranges.length - 1 ? [...rows, '(more below)'] : rows
    return { text: shown.join('\n'), fitsOneScreen: shown.length <= SCREEN_ROWS }
  })
}

// The start of a section, cut at a line break to fit a full rebuild's
// 1000-character ceiling. Jarvis shows this first, then the whole section
// by an in-place update once the page is on screen (tool.ts).
export function rebuildSafe(text: string): string {
  const limit = REBUILD_MAX_CHARS - 10
  if (text.length <= limit) return text
  const cut = text.lastIndexOf('\n', limit)
  return text.slice(0, cut > 0 ? cut : limit)
}

// Whether a block of code is short enough to read as text on the glasses.
export function fitsAsText(code: string, innerWidth: number): boolean {
  return wrapLines(code, innerWidth).length <= CODE_TEXT_MAX_ROWS
}

// The last screenful of an answer that is still arriving (G2-104): the
// newest line at the bottom, older ones rolling off the top, like typing.
// It is always one screen, so there is nothing to scroll - the firmware
// sends every content update back to the top, which used to undo the
// wearer's scrolling several times a second while a reply streamed in.
export function tailRows(text: string, innerWidth: number, rows = SCREEN_ROWS): string {
  const lines = wrapLines(text, innerWidth)
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const tail = lines.slice(-rows)
  while (tail.length > 0 && tail[0] === '') tail.shift()
  return tail.join('\n')
}
