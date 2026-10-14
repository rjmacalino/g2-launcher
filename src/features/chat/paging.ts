import { CANVAS_WIDTH, CONTENT_HEIGHT, PADDING, ROW_HEIGHT_PX } from '../../platform/page'
import { getTextWidth } from '../../platform/text'

// Lays text out into pages that each fit one glasses screen, so an answer
// of any length can be shown in full by paging through it (see
// features/chat/tool.ts for why one screen update cannot simply carry it
// all). Pure - no I/O, no SDK - so it can be tested against the real
// LVGL-matching font measurement (tests/chat-paging.test.ts).
//
// Line breaks are decided here rather than left to the firmware: every
// line is measured to fit innerWidth and ends in an explicit newline, so
// the firmware never has to wrap anything itself, and a page holds exactly
// the rows it was given - it cannot overflow onto a row that is not there.

// The glasses content area (see platform/page.ts): full canvas width and
// CONTENT_HEIGHT tall, minus the container's own padding on each side. The
// extra 8px off the width is a safety margin, so a line measured right at
// the edge can never be wrapped again by the firmware. 8 rows fit; the
// last is kept for the "(2/5)" position indicator.
export const PAGE_INNER_WIDTH = CANVAS_WIDTH - 2 * PADDING - 8
export const PAGE_ROWS = Math.floor((CONTENT_HEIGHT - 2 * PADDING) / ROW_HEIGHT_PX)
export const PAGE_TEXT_ROWS = PAGE_ROWS - 1

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

// textRows is the number of rows of text per page. A multi-page result
// adds one more row to every page for the position indicator, so the
// caller passes one fewer than the screen holds.
export function paginate(text: string, innerWidth: number, textRows: number): string[] {
  const lines = wrapLines(text, innerWidth)
  const chunks: string[][] = []
  for (const line of lines) {
    const current = chunks[chunks.length - 1]
    if (!current || current.length === textRows) {
      // A page never starts on a blank line - it would just look empty.
      if (line === '') continue
      chunks.push([line])
    } else {
      current.push(line)
    }
  }
  if (chunks.length <= 1) return [lines.join('\n')]
  return chunks.map((chunk, i) => {
    const position = `${i + 1}/${chunks.length}`
    const hint = i < chunks.length - 1 ? `(${position} - swipe down for more)` : `(${position})`
    return `${chunk.join('\n')}\n${hint}`
  })
}
