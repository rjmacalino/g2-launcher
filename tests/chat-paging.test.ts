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

const { paginate, rebuildSafe, PAGE_INNER_WIDTH, SCREEN_ROWS, PAGE_MAX_CHARS, OVERLAP_ROWS } =
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

// The rows a section adds on top of new text: lines repeated from the
// previous section at the top, and "(more below)" at the bottom of all but
// the last.
function rowsWithoutHint(pageText: string, index: number, total: number): string[] {
  const rows = pageText.split('\n')
  return index < total - 1 ? rows.slice(0, -1) : rows
}

// How many of a section's first rows repeat the end of the previous one.
function carriedCount(previous: string[], current: string[]): number {
  const tail = [...previous]
  while (tail.length > 0 && tail[tail.length - 1] === '') tail.pop()
  for (let k = Math.min(OVERLAP_ROWS, current.length); k > 0; k--) {
    if (tail.slice(-k).join('\n') === current.slice(0, k).join('\n')) return k
  }
  return 0
}

function newRowsOf(pages: { text: string }[]): string[] {
  return pages.flatMap((page, i) => {
    const rows = rowsWithoutHint(page.text, i, pages.length)
    if (i === 0) return rows
    const previous = rowsWithoutHint(pages[i - 1].text, i - 1, pages.length)
    return rows.slice(carriedCount(previous, rows))
  })
}

describe('paginate', () => {
  it('uses the real screen, and sections as long as an in-place update allows', () => {
    expect(SCREEN_ROWS).toBe(9)
    expect(PAGE_MAX_CHARS).toBeLessThan(2000)
  })

  it('fits a typical answer with code in one continuous scroll', () => {
    const code = Array.from({ length: 30 }, (_, i) => `  line ${i}: x = x + ${i}`).join('\n')
    const pages = paginate(`You: two sum?\nJarvis: ${code}\nUse a hash map.`, PAGE_INNER_WIDTH)
    expect(pages).toHaveLength(1)
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
      for (const row of rows) expect(getTextWidth(row)).toBeLessThanOrEqual(PAGE_INNER_WIDTH)
      expect(page.text.length).toBeLessThanOrEqual(PAGE_MAX_CHARS)
      expect(rebuildSafe(page.text).length).toBeLessThan(REBUILD_CHAR_LIMIT)
    }
  })

  it('repeats the last lines read at the top of the next page', () => {
    const pages = paginate(longAnswer(8), PAGE_INNER_WIDTH)
    for (let i = 1; i < pages.length; i++) {
      const previousRows = pages[i - 1].text
        .split('\n')
        .slice(0, -1)
        .filter(r => r !== '')
      const carried = pages[i].text.split('\n').slice(0, 2)
      expect(previousRows.slice(-OVERLAP_ROWS)).toEqual(expect.arrayContaining(carried))
    }
  })

  it('loses no words and keeps their order across pages', () => {
    const text = longAnswer(8)
    const pages = paginate(text, PAGE_INNER_WIDTH)
    const rebuilt = newRowsOf(pages).join('\n')
    expect(wordsOf(rebuilt)).toEqual(wordsOf(text))
  })

  it('says "more below" on every section but the last, with no page numbers', () => {
    const pages = paginate(longAnswer(16), PAGE_INNER_WIDTH)
    expect(pages.length).toBeGreaterThan(1)
    pages.forEach((page, i) => {
      expect(page.text.endsWith('(more below)')).toBe(i < pages.length - 1)
      expect(page.text).not.toMatch(/\(\d+\/\d+/)
    })
  })

  it('cuts a long section at a line break for a rebuild', () => {
    const text = Array.from({ length: 80 }, (_, i) => `line number ${i}`).join('\n')
    const cut = rebuildSafe(text)
    expect(cut.length).toBeLessThan(REBUILD_CHAR_LIMIT)
    expect(text.startsWith(cut)).toBe(true)
    expect(text[cut.length]).toBe('\n')
    expect(rebuildSafe('short')).toBe('short')
  })

  it('never starts a page on a blank line', () => {
    for (const page of paginate(longAnswer(8), PAGE_INNER_WIDTH)) {
      expect(page.text.startsWith('\n')).toBe(false)
    }
  })

  it('keeps code indentation, including on wrapped lines', () => {
    const code = 'def f(x):\n  if x:\n    return x\n\tpass'
    const text = paginate(code, PAGE_INNER_WIDTH)[0].text
    expect(text.split('\n')).toEqual(['def f(x):', '  if x:', '    return x', '  pass'])
    const long = `    ${'word '.repeat(40).trim()}`
    for (const row of paginate(long, PAGE_INNER_WIDTH)[0].text.split('\n')) {
      expect(row.startsWith('    ')).toBe(true)
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
