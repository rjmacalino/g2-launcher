import { describe, expect, it } from 'vitest'
import { nextShown } from '../src/features/chat/typing'

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
