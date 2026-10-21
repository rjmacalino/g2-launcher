import { describe, expect, it, vi } from 'vitest'

// paging.ts imports the screen geometry, which imports the glasses bridge and
// its wait for the Even Hub; there is none under Vitest (see chat-paging).
vi.mock('../src/platform/bridge', () => ({
  bridge: {},
  status: vi.fn(),
}))

const { PAGE_MAX_CHARS, PAGE_ROWS, SCREEN_ROWS } = await import('../src/features/chat/paging')
const { movePaged, moveView, tailWin, viewLabel, viewPages, windowText } =
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

  it('goes up by landing on the last screenful above, never repeating a row', () => {
    const all = rows(100)
    const pages = viewPages(all)
    // From the typed tail (the last screenful of page 4) up to the rest of it.
    let win = moveView(all, tailWin(all), -1)
    expect(win).toEqual({ start: tailWin(all).start - SCREEN_ROWS, end: tailWin(all).start })
    // From the top of page 4: the last screenful of page 3.
    win = moveView(all, pages[3], -1)
    expect(win).toEqual({ start: pages[2].end - SCREEN_ROWS, end: pages[2].end })
    // And again: the screenful before that.
    win = moveView(all, win!, -1)
    expect(win).toEqual({ start: pages[2].end - 2 * SCREEN_ROWS, end: pages[2].end - SCREEN_ROWS })
    expect(moveView(all, pages[0], -1)).toBeNull()
  })

  it('goes down through the rest of a page, then the next whole page, and stops at the last', () => {
    const all = rows(100)
    const pages = viewPages(all)
    expect(moveView(all, pages[0], 1)).toEqual(pages[1])
    const landed = { start: pages[2].end - SCREEN_ROWS, end: pages[2].end }
    expect(moveView(all, landed, 1)).toEqual(pages[3])
    const partial = { start: pages[2].start, end: pages[2].start + SCREEN_ROWS }
    expect(moveView(all, partial, 1)).toEqual({ start: partial.end, end: pages[2].end })
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

describe('movePaged (G2-124)', () => {
  const lengths = [27, 27, 12]

  it('lands on the last screenful of the page above, then steps back by screenfuls', () => {
    let at = movePaged(lengths, { page: 1, win: null }, -1)
    expect(at).toEqual({ page: 0, win: { start: 27 - SCREEN_ROWS, end: 27 } })
    at = movePaged(lengths, at!, -1)
    expect(at).toEqual({ page: 0, win: { start: 27 - 2 * SCREEN_ROWS, end: 27 - SCREEN_ROWS } })
  })

  it('shows a short page above whole', () => {
    expect(movePaged([5, 27], { page: 1, win: null }, -1)).toEqual({ page: 0, win: null })
  })

  it('goes down through the rest of the page before the next one', () => {
    const at = { page: 0, win: { start: 0, end: SCREEN_ROWS } }
    expect(movePaged(lengths, at, 1)).toEqual({ page: 0, win: { start: SCREEN_ROWS, end: 27 } })
    expect(movePaged(lengths, { page: 0, win: { start: 18, end: 27 } }, 1)).toEqual({
      page: 1,
      win: null,
    })
    expect(movePaged(lengths, { page: 2, win: null }, 1)).toBeNull()
  })
})
