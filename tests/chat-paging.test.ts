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

const { paginate, PAGE_INNER_WIDTH, SCREEN_ROWS, PAGE_TEXT_ROWS, PAGE_MAX_CHARS, OVERLAP_ROWS } =
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

// The rows a page adds on top of new text: lines repeated from the previous
// page at the top, and the "(2/5 ...)" indicator at the bottom.
function newRowsOf(pageText: string, index: number, total: number): string[] {
  const rows = pageText.split('\n')
  const withoutHint = total > 1 ? rows.slice(0, -1) : rows
  return index === 0 ? withoutHint : withoutHint.slice(OVERLAP_ROWS)
}

describe('paginate', () => {
  it('uses the real screen: 8 rows per screen, pages about two screens tall', () => {
    expect(SCREEN_ROWS).toBe(8)
    expect(PAGE_TEXT_ROWS).toBe(15)
  })

  it('leaves a short answer as one page with no indicator, fully visible', () => {
    const pages = paginate('You: what time is it?\n\nGemini: It is noon.', PAGE_INNER_WIDTH)
    expect(pages).toHaveLength(1)
    expect(pages[0].text).not.toMatch(/\(1\//)
    expect(pages[0].fitsOneScreen).toBe(true)
  })

  it('makes pages taller than one screen, so they scroll smoothly within', () => {
    const pages = paginate(longAnswer(8), PAGE_INNER_WIDTH)
    expect(pages.length).toBeGreaterThan(1)
    expect(pages[0].text.split('\n').length).toBeGreaterThan(SCREEN_ROWS)
    expect(pages[0].fitsOneScreen).toBe(false)
  })

  it('keeps every page inside the row, width and firmware size limits', () => {
    for (const page of paginate(longAnswer(12), PAGE_INNER_WIDTH)) {
      const rows = page.text.split('\n')
      expect(rows.length).toBeLessThanOrEqual(PAGE_TEXT_ROWS + 1)
      for (const row of rows) expect(getTextWidth(row)).toBeLessThanOrEqual(PAGE_INNER_WIDTH)
      expect(page.text.length).toBeLessThanOrEqual(PAGE_MAX_CHARS)
      expect(page.text.length).toBeLessThan(REBUILD_CHAR_LIMIT)
    }
  })

  it('repeats the last lines read at the top of the next page', () => {
    const pages = paginate(longAnswer(8), PAGE_INNER_WIDTH)
    for (let i = 1; i < pages.length; i++) {
      const previousRows = pages[i - 1].text
        .split('\n')
        .slice(0, -1)
        .filter(r => r !== '')
      const carried = pages[i].text.split('\n').slice(0, OVERLAP_ROWS)
      expect(carried).toEqual(previousRows.slice(-OVERLAP_ROWS))
    }
  })

  it('loses no words and keeps their order across pages', () => {
    const text = longAnswer(8)
    const pages = paginate(text, PAGE_INNER_WIDTH)
    const rebuilt = pages.flatMap((page, i) => newRowsOf(page.text, i, pages.length)).join('\n')
    expect(wordsOf(rebuilt)).toEqual(wordsOf(text))
  })

  it('numbers every page and tells the wearer to keep swiping on all but the last', () => {
    const pages = paginate(longAnswer(8), PAGE_INNER_WIDTH)
    pages.forEach((page, i) => {
      const position = `${i + 1}/${pages.length}`
      if (i < pages.length - 1)
        expect(page.text.endsWith(`(${position} - keep swiping down for more)`)).toBe(true)
      else expect(page.text.endsWith(`(${position})`)).toBe(true)
    })
  })

  it('never starts a page on a blank line', () => {
    for (const page of paginate(longAnswer(8), PAGE_INNER_WIDTH)) {
      expect(page.text.startsWith('\n')).toBe(false)
    }
  })

  it('breaks a word too wide for one line instead of letting it overflow', () => {
    const url = `https://example.com/${'a'.repeat(300)}`
    const pages = paginate(`Gemini: see ${url}`, PAGE_INNER_WIDTH)
    for (const page of pages) {
      for (const row of page.text.split('\n')) {
        expect(getTextWidth(row)).toBeLessThanOrEqual(PAGE_INNER_WIDTH)
      }
    }
    expect(pages.map(p => p.text).join('')).toContain('a'.repeat(50))
  })

  it('measures the question/answer divider glyph as a real, fitting line', () => {
    const divider = String.fromCharCode(0x2500).repeat(12)
    expect(getTextWidth(divider)).toBeGreaterThan(0)
    const pages = paginate(`You: hi\n${divider}\nGemini: hello`, PAGE_INNER_WIDTH)
    expect(pages).toHaveLength(1)
    expect(pages[0].text).toContain(divider)
  })
})
