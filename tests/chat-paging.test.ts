import { describe, expect, it, vi } from 'vitest'
import { getTextWidth } from '@evenrealities/pretext'

// paging.ts imports platform/page.ts for the real screen geometry, which in
// turn imports platform/bridge.ts and its top-level wait for the Even Hub
// bridge - there is no bridge under Vitest. Mocked so the import does not
// hang; the paging code itself never touches the bridge.
vi.mock('../src/platform/bridge', () => ({
  bridge: {},
  status: vi.fn(),
}))

const { paginate, PAGE_INNER_WIDTH, PAGE_ROWS, PAGE_TEXT_ROWS } =
  await import('../src/features/chat/paging')

// The firmware's hard ceiling on content in a page rebuild, the stricter of
// its two limits (docs/platform.md).
const REBUILD_CHAR_LIMIT = 1000

const sentence =
  'The quick brown fox jumps over the lazy dog while the wearer reads this on tiny glasses.'

function longAnswer(paragraphs: number): string {
  return Array.from({ length: paragraphs }, (_, p) =>
    Array.from({ length: 5 }, (_, s) => `Paragraph ${p + 1}, sentence ${s + 1}. ${sentence}`).join(
      ' ',
    ),
  ).join('\n\n')
}

function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(w => w !== '')
}

// Removes the "(2/5 - swipe down for more)" indicator row a multi-page
// result adds to the end of every page.
function stripHint(page: string): string {
  return page.replace(/\n\(\d+\/\d+( - swipe down for more)?\)$/, '')
}

describe('paginate', () => {
  it('fits the real screen: 8 rows, one kept for the page indicator', () => {
    expect(PAGE_ROWS).toBe(8)
    expect(PAGE_TEXT_ROWS).toBe(7)
  })

  it('leaves a short answer as one page with no indicator', () => {
    const pages = paginate(
      'You: what time is it?\n\nGemini: It is noon.',
      PAGE_INNER_WIDTH,
      PAGE_TEXT_ROWS,
    )
    expect(pages).toHaveLength(1)
    expect(pages[0]).not.toMatch(/\(1\//)
  })

  it('splits a long answer into pages that each fit one screen', () => {
    const pages = paginate(longAnswer(8), PAGE_INNER_WIDTH, PAGE_TEXT_ROWS)
    expect(pages.length).toBeGreaterThan(3)
    for (const page of pages) {
      const rows = page.split('\n')
      expect(rows.length).toBeLessThanOrEqual(PAGE_ROWS)
      for (const row of rows) expect(getTextWidth(row)).toBeLessThanOrEqual(PAGE_INNER_WIDTH)
      expect(page.length).toBeLessThan(REBUILD_CHAR_LIMIT)
    }
  })

  it('loses no words and keeps their order across pages', () => {
    const text = longAnswer(8)
    const pages = paginate(text, PAGE_INNER_WIDTH, PAGE_TEXT_ROWS)
    expect(wordsOf(pages.map(stripHint).join('\n'))).toEqual(wordsOf(text))
  })

  it('numbers every page and tells the wearer to swipe on all but the last', () => {
    const pages = paginate(longAnswer(8), PAGE_INNER_WIDTH, PAGE_TEXT_ROWS)
    pages.forEach((page, i) => {
      const position = `${i + 1}/${pages.length}`
      if (i < pages.length - 1)
        expect(page.endsWith(`(${position} - swipe down for more)`)).toBe(true)
      else expect(page.endsWith(`(${position})`)).toBe(true)
    })
  })

  it('never starts a page on a blank line', () => {
    const pages = paginate(longAnswer(8), PAGE_INNER_WIDTH, PAGE_TEXT_ROWS)
    for (const page of pages) expect(page.startsWith('\n')).toBe(false)
  })

  it('breaks a word too wide for one line instead of letting it overflow', () => {
    const url = `https://example.com/${'a'.repeat(300)}`
    const pages = paginate(`Gemini: see ${url}`, PAGE_INNER_WIDTH, PAGE_TEXT_ROWS)
    const rows = pages.map(stripHint).join('\n').split('\n')
    for (const row of rows) expect(getTextWidth(row)).toBeLessThanOrEqual(PAGE_INNER_WIDTH)
    expect(rows.join('')).toContain('a'.repeat(50))
  })

  it('measures the question/answer divider glyph as a real, fitting line', () => {
    const divider = String.fromCharCode(0x2500).repeat(12)
    expect(getTextWidth(divider)).toBeGreaterThan(0)
    const pages = paginate(`You: hi\n${divider}\nGemini: hello`, PAGE_INNER_WIDTH, PAGE_TEXT_ROWS)
    expect(pages).toHaveLength(1)
    expect(pages[0]).toContain(divider)
  })
})
