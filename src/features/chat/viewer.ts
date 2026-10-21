import { positionLabel } from '../../shared/position'
import { SCREEN_ROWS, pageRanges, wrapLines, type RowRange } from './paging'

// Reading an answer that is paused or has just finished typing (G2-107,
// G2-116). The glasses cannot be scrolled to a position and every update
// starts at the top, so the text is shown a page at a time - the same pages
// a finished answer has (paging.ts: up to three screens, smooth scrolling
// inside, the next page starting on the very next line). What is on screen
// is a range of rows: the last screenful while typing, or a whole page.
// Pure, tested in tests/viewer.test.ts.

export type Win = RowRange

export function rowsOf(text: string, innerWidth: number): string[] {
  const rows = wrapLines(text, innerWidth)
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop()
  return rows
}

// The last screenful - what the typing view shows.
export function tailWin(rows: readonly string[]): Win {
  return { start: Math.max(0, rows.length - SCREEN_ROWS), end: rows.length }
}

export function viewPages(rows: readonly string[]): Win[] {
  return pageRanges(rows)
}

// The page a row is on (the last page for a row past the end).
export function pageIndexAt(pages: readonly Win[], row: number): number {
  for (let i = 0; i < pages.length; i++) if (row < pages[i].end) return i
  return Math.max(0, pages.length - 1)
}

// Where a swipe past the top (-1) or bottom (1) edge goes: down is the next
// page, up is the top of the page the view is in - or the page before, when
// the view already starts there. null when there is nowhere further.
export function moveView(rows: readonly string[], win: Win, delta: -1 | 1): Win | null {
  const pages = viewPages(rows)
  if (pages.length === 0) return null
  if (delta === -1) {
    const p = pageIndexAt(pages, win.start)
    if (win.start > pages[p].start) return pages[p]
    return p > 0 ? pages[p - 1] : null
  }
  const p = pageIndexAt(pages, Math.max(win.start, win.end - 1))
  return p + 1 < pages.length ? pages[p + 1] : null
}

// "Page 2 of 4" for what is on screen; null for a single page.
export function viewLabel(rows: readonly string[], win: Win): string | null {
  const pages = viewPages(rows)
  return positionLabel(pageIndexAt(pages, Math.max(win.start, win.end - 1)), pages.length)
}

export function windowText(rows: readonly string[], win: Win): string {
  return rows.slice(win.start, win.end).join('\n')
}

// A few in-between pictures for a page change (G2-113), so the wearer sees
// the page slide rather than blink: going on (dir 1) the old screen moves up
// as the new one rises in below it, going back (dir -1) the new one comes
// down from above. Only what is on screen counts: a swipe at the bottom edge
// means the old page's last rows are showing, and one at the top edge its
// first rows; the new page always begins at its top. The real page is drawn
// after the last frame. Pure, tested in tests/slide-frames.test.ts.
export function slideFrames(
  from: readonly string[],
  to: readonly string[],
  dir: 1 | -1,
  rows = SCREEN_ROWS,
  step = 2,
): string[] {
  const pad = (r: readonly string[]) =>
    r.length < rows ? [...r, ...Array.from({ length: rows - r.length }, () => '')] : [...r]
  const old = pad(dir === 1 ? from.slice(-rows) : from.slice(0, rows))
  const next = pad(to.slice(0, rows))
  const frames: string[] = []
  for (let k = step; k < rows; k += step) {
    const strip =
      dir === 1
        ? [...old, ...next].slice(k, k + rows)
        : [...next, ...old].slice(rows - k, 2 * rows - k)
    frames.push(strip.join('\n'))
  }
  return frames
}
