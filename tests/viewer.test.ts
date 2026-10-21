import { describe, expect, it, vi } from 'vitest'

// paging.ts imports the screen geometry, which imports the glasses bridge and
// its wait for the Even Hub; there is none under Vitest (see chat-paging).
vi.mock('../src/platform/bridge', () => ({
  bridge: {},
  status: vi.fn(),
}))

const { PAGE_MAX_CHARS, PAGE_ROWS, SCREEN_ROWS } = await import('../src/features/chat/paging')
const { moveView, tailWin, viewLabel, viewPages, windowText } =
  await import('../src/features/chat/viewer')

const rows = (n: number) => Array.from({ length: n }, (_, i) => `row ${i}`)

describe('viewer pages (G2-107, G2-116)', () => {
  it('starts on the last screenful', () => {
    expect(tailWin(rows(30))).toEqual({ start: 30 - SCREEN_ROWS, end: 30 })
    expect(tailWin(rows(3))).toEqual({ start: 0, end: 3 })
  })

  it('cuts the rows into pages of three screens, each starting on the next line', () => {
    const pages = viewPages(rows(100))
    expect(pages).toHaveLength(4)
    expect(pages[0]).toEqual({ start: 0, end: PAGE_ROWS })
    for (let i = 1; i < pages.length; i++) expect(pages[i].start).toBe(pages[i - 1].end)
    expect(pages[3].end).toBe(100)
  })

  it('goes up from the screen being looked at to the top of its page, then page by page', () => {
    const all = rows(100)
    const pages = viewPages(all)
    let win = moveView(all, tailWin(all), -1)
    expect(win).toEqual(pages[3])
    win = moveView(all, win!, -1)
    expect(win).toEqual(pages[2])
    win = moveView(all, win!, -1)
    win = moveView(all, win!, -1)
    expect(win).toEqual(pages[0])
    expect(moveView(all, win!, -1)).toBeNull()
  })

  it('goes down to the next page, and stops at the last', () => {
    const all = rows(100)
    const pages = viewPages(all)
    expect(moveView(all, pages[0], 1)).toEqual(pages[1])
    expect(moveView(all, pages[2], 1)).toEqual(pages[3])
    expect(moveView(all, pages[3], 1)).toBeNull()
    expect(moveView(all, tailWin(all), 1)).toBeNull()
  })

  it('has nowhere to go in a short text', () => {
    const short = rows(4)
    expect(moveView(short, tailWin(short), -1)).toBeNull()
    expect(moveView(short, tailWin(short), 1)).toBeNull()
  })

  it('says which page is on screen, and nothing for a single page', () => {
    const all = rows(100)
    const pages = viewPages(all)
    expect(viewLabel(all, tailWin(all))).toBe('Page 4 of 4')
    expect(viewLabel(all, pages[0])).toBe('Page 1 of 4')
    expect(viewLabel(rows(5), tailWin(rows(5)))).toBeNull()
  })

  it('keeps a page under the character limit', () => {
    const wide = Array.from({ length: 60 }, () => 'x'.repeat(80))
    for (const page of viewPages(wide)) {
      expect(windowText(wide, page).length).toBeLessThanOrEqual(PAGE_MAX_CHARS)
    }
  })
})
