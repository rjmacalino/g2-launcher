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

// A place in rows cut into pages: the page and the part of it on screen
// (null: the whole page), counted in rows from the page's own start.
export type PagePlace = { page: number; win: Win | null }

// Where a swipe past the top (-1) or bottom (1) edge goes (G2-124). The
// glasses cannot be scrolled to a position and every update starts at the
// top, so going back lands on the last screenful of what is above - the
// wearer comes from below - and a further swipe up steps back a screenful
// at a time, then on to the page before. Going down shows the rest of the
// page, then the next whole page. Nothing is ever repeated. null when there
// is nowhere further. `lengths` are the pages' row counts.
export function movePaged(
  lengths: readonly number[],
  at: PagePlace,
  delta: -1 | 1,
): PagePlace | null {
  const length = lengths[at.page] ?? 0
  const cur = at.win ?? { start: 0, end: length }
  if (delta === 1) {
    if (cur.end < length) return { page: at.page, win: { start: cur.end, end: length } }
    return at.page + 1 < lengths.length ? { page: at.page + 1, win: null } : null
  }
  if (cur.start > 0) {
    return {
      page: at.page,
      win: { start: Math.max(0, cur.start - SCREEN_ROWS), end: cur.start },
    }
  }
  if (at.page === 0) return null
  const before = lengths[at.page - 1]
  const start = Math.max(0, before - SCREEN_ROWS)
  return { page: at.page - 1, win: start === 0 ? null : { start, end: before } }
}

// The same for a view over all of an answer's rows.
export function moveView(rows: readonly string[], win: Win, delta: -1 | 1): Win | null {
  const pages = viewPages(rows)
  if (pages.length === 0) return null
  const page = pageIndexAt(pages, delta === -1 ? win.start : Math.max(win.start, win.end - 1))
  const from = pages[page]
  const whole = win.start <= from.start && win.end >= from.end
  const to = movePaged(
    pages.map(p => p.end - p.start),
    {
      page,
      win: whole ? null : { start: win.start - from.start, end: win.end - from.start },
    },
    delta,
  )
  if (!to) return null
  const base = pages[to.page].start
  return to.win ? { start: base + to.win.start, end: base + to.win.end } : pages[to.page]
}

// "Page 2 of 4" for what is on screen; null for a single page.
export function viewLabel(rows: readonly string[], win: Win): string | null {
  const pages = viewPages(rows)
  return positionLabel(pageIndexAt(pages, Math.max(win.start, win.end - 1)), pages.length)
}

export function windowText(rows: readonly string[], win: Win): string {
  return rows.slice(win.start, win.end).join('\n')
}
