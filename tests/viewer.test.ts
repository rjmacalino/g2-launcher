import { describe, expect, it, vi } from 'vitest'

// paging.ts imports the screen geometry, which imports the glasses bridge and
// its wait for the Even Hub; there is none under Vitest (see chat-paging).
vi.mock('../src/platform/bridge', () => ({
  bridge: {},
  status: vi.fn(),
}))

const { OVERLAP_ROWS, SCREEN_ROWS } = await import('../src/features/chat/paging')
const { WINDOW_MAX_CHARS, WINDOW_ROWS, moveWindow, tailWin, windowText } =
  await import('../src/features/chat/viewer')

const rows = (n: number) => Array.from({ length: n }, (_, i) => `row ${i}`)

describe('viewer windows (G2-107)', () => {
  it('starts on the last screenful', () => {
    expect(tailWin(rows(30))).toEqual({ start: 30 - SCREEN_ROWS, end: 30 })
    expect(tailWin(rows(3))).toEqual({ start: 0, end: 3 })
  })

  it('goes up from the screen being looked at: a window ending where it ends', () => {
    const all = rows(60)
    const up = moveWindow(all, tailWin(all), -1)
    expect(up).toEqual({ start: 60 - WINDOW_ROWS, end: 60 })
  })

  it('keeps going up by windows that overlap by a few rows, until the start', () => {
    const all = rows(60)
    let win = moveWindow(all, tailWin(all), -1)!
    const next = moveWindow(all, win, -1)!
    expect(next.end).toBe(win.start + OVERLAP_ROWS)
    win = next
    for (let i = 0; i < 10 && win.start > 0; i++) win = moveWindow(all, win, -1) ?? win
    expect(win.start).toBe(0)
    expect(moveWindow(all, win, -1)).toBeNull()
  })

  it('goes down from the screen being looked at, overlapping a few rows', () => {
    const all = rows(60)
    const here = { start: 10, end: 10 + SCREEN_ROWS }
    expect(moveWindow(all, here, 1)).toEqual({
      start: here.end - OVERLAP_ROWS,
      end: here.end - OVERLAP_ROWS + WINDOW_ROWS,
    })
  })

  it('stops at the end, and a short text has nowhere to go', () => {
    const all = rows(60)
    expect(moveWindow(all, tailWin(all), 1)).toBeNull()
    const short = rows(4)
    expect(moveWindow(short, tailWin(short), -1)).toBeNull()
    expect(moveWindow(short, tailWin(short), 1)).toBeNull()
  })

  it('keeps a window under the character limit', () => {
    const wide = Array.from({ length: 40 }, () => 'x'.repeat(80))
    const up = moveWindow(wide, tailWin(wide), -1)!
    expect(windowText(wide, up).length).toBeLessThanOrEqual(WINDOW_MAX_CHARS)
    expect(up.end).toBe(40)
  })
})
