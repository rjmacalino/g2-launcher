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

const { paginate, rebuildSafe, PAGE_INNER_WIDTH, SCREEN_ROWS, PAGE_MAX_CHARS, PAGE_ROWS } =
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

// The rows of a page without its "(more below)" line, which every page
// but the last ends with.
function rowsWithoutHint(pageText: string, index: number, total: number): string[] {
  const rows = pageText.split('\n')
  return index < total - 1 ? rows.slice(0, -1) : rows
}

function newRowsOf(pages: { text: string }[]): string[] {
  return pages.flatMap((page, i) => rowsWithoutHint(page.text, i, pages.length))
}

describe('paginate', () => {
  it('uses the real screen, and sections as long as an in-place update allows', () => {
    expect(SCREEN_ROWS).toBe(9)
    expect(PAGE_MAX_CHARS).toBeLessThan(2000)
  })

  it('fits a typical answer with a little code on one page', () => {
    const code = Array.from({ length: 12 }, (_, i) => `  line ${i}: x = x + ${i}`).join('\n')
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

  it('makes a page three screens at most, and 100 numbers four pages (G2-116)', () => {
    expect(PAGE_ROWS).toBe(SCREEN_ROWS * 3)
    const numbers = Array.from({ length: 100 }, (_, i) => String(i + 1)).join('\n')
    const pages = paginate(numbers, PAGE_INNER_WIDTH)
    expect(pages).toHaveLength(4)
    for (const [i, page] of pages.entries()) {
      expect(rowsWithoutHint(page.text, i, pages.length).length).toBeLessThanOrEqual(PAGE_ROWS)
    }
  })

  it('starts each page on the very next line, repeating nothing (G2-116)', () => {
    const numbers = Array.from({ length: 100 }, (_, i) => String(i + 1)).join('\n')
    const pages = paginate(numbers, PAGE_INNER_WIDTH)
    for (let i = 1; i < pages.length; i++) {
      const before = rowsWithoutHint(pages[i - 1].text, i - 1, pages.length)
      const after = rowsWithoutHint(pages[i].text, i, pages.length)
      expect(Number(after[0])).toBe(Number(before[before.length - 1]) + 1)
    }
    expect(newRowsOf(pages)).toEqual(numbers.split('\n'))
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

describe('fitsAsText (G2-103)', () => {
  it('keeps short code as text and turns tall code into pictures', async () => {
    const { fitsAsText, PAGE_INNER_WIDTH, CODE_TEXT_MAX_ROWS } =
      await import('../src/features/chat/paging')
    expect(fitsAsText('count = 0', PAGE_INNER_WIDTH)).toBe(true)
    expect(fitsAsText('a = 1\nb = 2\nc = 3\nd = 4\ne = 5', PAGE_INNER_WIDTH)).toBe(true)
    const tall = Array.from({ length: CODE_TEXT_MAX_ROWS + 1 }, (_, i) => `x${i} = ${i}`).join('\n')
    expect(fitsAsText(tall, PAGE_INNER_WIDTH)).toBe(false)
  })
})

describe('tailRows (G2-104)', () => {
  it('shows the newest rows of a growing answer, one screen at most', async () => {
    const { tailRows, PAGE_INNER_WIDTH, SCREEN_ROWS } = await import('../src/features/chat/paging')
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
    const tail = tailRows(lines.join('\n'), PAGE_INNER_WIDTH).split('\n')
    expect(tail).toHaveLength(SCREEN_ROWS)
    expect(tail[tail.length - 1]).toBe('line 30')
    expect(tail[0]).toBe(`line ${30 - SCREEN_ROWS + 1}`)
  })

  it('shows a short answer whole, and never starts or ends on a blank row', async () => {
    const { tailRows, PAGE_INNER_WIDTH } = await import('../src/features/chat/paging')
    expect(tailRows('Hello there.', PAGE_INNER_WIDTH)).toBe('Hello there.')
    expect(tailRows('one\n\ntwo\n\n', PAGE_INNER_WIDTH)).toBe('one\n\ntwo')
  })
})

describe('lowerPageLimit (G2-106)', () => {
  it('splits long answers into sections the strict limit accepts, once lowered', async () => {
    vi.resetModules()
    const m = await import('../src/features/chat/paging')
    const long = Array.from(
      { length: 40 },
      (_, i) => `Sentence number ${i} says something useful.`,
    ).join(' ')
    expect(
      Math.max(...m.paginate(long, m.PAGE_INNER_WIDTH).map(p => p.text.length)),
    ).toBeGreaterThan(1000)
    expect(m.lowerPageLimit()).toBe(true)
    expect(
      Math.max(...m.paginate(long, m.PAGE_INNER_WIDTH).map(p => p.text.length)),
    ).toBeLessThanOrEqual(1000)
    expect(m.lowerPageLimit()).toBe(false)
  })
})
