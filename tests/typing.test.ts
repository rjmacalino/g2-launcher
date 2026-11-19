import { describe, expect, it } from 'vitest'
import { LEAD_MAX_CHARS, leadSentenceEnd, nextShown } from '../src/features/chat/typing'

describe('nextShown (G2-106)', () => {
  const text = 'The quick brown fox jumps over the lazy dog'

  it('moves on by the allowance, finishing the word it lands in', () => {
    expect(nextShown(text, 0, 5, true)).toBe(9)
    expect(nextShown(text, 9, 1, true)).toBe(15)
  })

  it('always makes progress, even with a tiny allowance', () => {
    expect(nextShown(text, 0, 0.2, true)).toBeGreaterThan(0)
  })

  it('shows everything once the model is done and the end is reached', () => {
    expect(nextShown(text, 30, 100, true)).toBe(text.length)
    expect(nextShown(text, text.length, 5, true)).toBe(text.length)
  })

  it('holds back a last word that may still be growing', () => {
    const partial = 'The quick brown fo'
    expect(nextShown(partial, 0, 100, false)).toBe('The quick brown '.length)
    // Nothing new to show yet: stay where it is.
    expect(nextShown(partial, 16, 100, false)).toBe(16)
  })
})

describe('leadSentenceEnd (G2-180)', () => {
  it('ends after the first sentence once the next character has arrived', () => {
    expect(leadSentenceEnd('So I need two numbers. Then')).toBe(22)
    expect(leadSentenceEnd('Is it sorted? Yes')).toBe(13)
  })

  it('takes a Code header line along with the sentence after it', () => {
    const text = 'LeetCode - Two Sum - Easy\n\nSo I need two indices. The'
    expect(text.slice(0, leadSentenceEnd(text))).toBe(
      'LeetCode - Two Sum - Easy\n\nSo I need two indices.',
    )
  })

  it('ends at a colon that ends a line: the Code opening line (G2-186)', () => {
    const text = 'For this HackerRank Tuples problem, use:\n\npseudo code:'
    expect(text.slice(0, leadSentenceEnd(text))).toBe('For this HackerRank Tuples problem, use:')
    // Not a colon inside a line, like "Note: this".
    expect(leadSentenceEnd('Note: this is it. More')).toBe(17)
  })

  it('waits while the sentence, or a number like 3.5, is still arriving', () => {
    expect(leadSentenceEnd('So I need')).toBe(0)
    expect(leadSentenceEnd('It costs 3.')).toBe(0)
    expect(leadSentenceEnd('It costs 3.5 and')).toBe(0)
  })

  it('never holds back more than a short lead', () => {
    expect(leadSentenceEnd(`${'word '.repeat(80)}end. More`)).toBe(0)
    expect(LEAD_MAX_CHARS).toBeLessThanOrEqual(300)
  })
})
