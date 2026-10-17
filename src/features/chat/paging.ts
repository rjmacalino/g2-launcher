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
// The last lines of a section, repeated at the top of the next one, so a
// long answer continues where the eye already is.
export const OVERLAP_ROWS = 3

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

// The last OVERLAP_ROWS non-blank lines of a page, to carry onto the next.
function overlapFrom(page: string[]): string[] {
  let end = page.length
  while (end > 0 && page[end - 1] === '') end--
  const carried = page.slice(Math.max(0, end - OVERLAP_ROWS), end)
  // Never carry a leading blank line: a section must not start empty.
  while (carried.length > 0 && carried[0] === '') carried.shift()
  return carried
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
    while (next < lines.length) {
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
    const rows = i < chunks.length - 1 ? [...chunk.lines, '(more below)'] : chunk.lines
    return { text: rows.join('\n'), fitsOneScreen: rows.length <= SCREEN_ROWS }
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
