import { describe, expect, it, vi } from 'vitest'

// notes/store.ts imports platform/bridge.ts, which does a top-level
// `await waitForEvenAppBridge()` against the real Even Hub WebView bridge -
// fine in the app, but there is no bridge to wait for under Vitest. Mocked
// here so importing the module under test does not hang; sanitizeItemTexts
// itself never touches bridge or status.
vi.mock('../src/platform/bridge', () => ({
  bridge: {},
  status: vi.fn(),
}))

const { sanitizeItemTexts, NOTE_MAX_ITEMS, NOTE_ITEM_MAX_CHARS } =
  await import('../src/features/notes/store')

describe('sanitizeItemTexts', () => {
  it('trims whitespace and drops empty rows', () => {
    expect(sanitizeItemTexts(['  milk  ', '', '   ', 'eggs'])).toEqual(['milk', 'eggs'])
  })

  it('caps the list at NOTE_MAX_ITEMS', () => {
    const texts = Array.from({ length: NOTE_MAX_ITEMS + 5 }, (_, i) => `item ${i}`)
    expect(sanitizeItemTexts(texts)).toHaveLength(NOTE_MAX_ITEMS)
  })

  it('caps each item at NOTE_ITEM_MAX_CHARS', () => {
    const long = 'x'.repeat(NOTE_ITEM_MAX_CHARS + 10)
    const [result] = sanitizeItemTexts([long])
    expect(result).toHaveLength(NOTE_ITEM_MAX_CHARS)
  })

  it('returns an empty list unchanged rather than throwing', () => {
    expect(sanitizeItemTexts([])).toEqual([])
  })
})
