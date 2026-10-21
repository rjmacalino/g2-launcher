import { OVERLAP_ROWS, SCREEN_ROWS, wrapLines } from './paging'

// Reading an answer that is paused or just finished typing (G2-107): the
// glasses cannot be scrolled to a position, and every update starts at the
// top, so the text is served in windows of up to three screens. Inside a
// window the firmware scrolls smoothly; a swipe past its top or bottom edge
// moves to the neighbouring window, which repeats a few rows so the eye keeps
// its place. The first window up from the screen being looked at ends where
// that screen ends, so the wearer lands just above it, not at the very start.
// Pure, tested in tests/viewer.test.ts.

export const WINDOW_ROWS = SCREEN_ROWS * 3
// Under the 1000 characters an update is known to accept (docs/platform.md).
export const WINDOW_MAX_CHARS = 900

// A span of rows [start, end) of the wrapped text.
export type Win = { start: number; end: number }

export function rowsOf(text: string, innerWidth: number): string[] {
  const rows = wrapLines(text, innerWidth)
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop()
  return rows
}

// The last screenful - what the typing view shows.
export function tailWin(rows: readonly string[]): Win {
  return { start: Math.max(0, rows.length - SCREEN_ROWS), end: rows.length }
}

function fitFromEnd(rows: readonly string[], end: number): Win {
  let start = end
  let chars = 0
  while (start > 0 && end - start < WINDOW_ROWS) {
    const add = rows[start - 1].length + 1
    if (chars + add > WINDOW_MAX_CHARS && end > start) break
    chars += add
    start--
  }
  return { start, end }
}

function fitFromStart(rows: readonly string[], start: number): Win {
  let end = start
  let chars = 0
  while (end < rows.length && end - start < WINDOW_ROWS) {
    const add = rows[end].length + 1
    if (chars + add > WINDOW_MAX_CHARS && end > start) break
    chars += add
    end++
  }
  return { start, end }
}

// The window after a swipe past the top (-1) or bottom (1) edge, or null when
// there is nowhere further to go.
export function moveWindow(rows: readonly string[], win: Win, delta: -1 | 1): Win | null {
  if (delta === -1) {
    if (win.start <= 0) return null
    const oneScreen = win.end - win.start <= SCREEN_ROWS
    const end = oneScreen ? win.end : Math.min(win.end, win.start + OVERLAP_ROWS)
    return fitFromEnd(rows, end)
  }
  if (win.end >= rows.length) return null
  return fitFromStart(rows, Math.max(0, win.end - OVERLAP_ROWS))
}

export function windowText(rows: readonly string[], win: Win): string {
  return rows.slice(win.start, win.end).join('\n')
}
