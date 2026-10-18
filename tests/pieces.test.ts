import { describe, expect, it } from 'vitest'
import { pickCut } from '../src/shared/pieces'

const rule = { minSamples: 600, searchFromSamples: 300 }

describe('pickCut (G2-82)', () => {
  it('waits until a piece is long enough', () => {
    expect(pickCut([100, 100, 100], [1, 1, 1], 0, rule)).toBeNull()
  })

  it('cuts at the quietest frame in the later part of the piece', () => {
    const sizes = [100, 100, 100, 100, 100, 100, 100]
    // Frame 0 is the quietest overall but too early; frame 4 wins.
    const levels = [0, 5, 5, 5, 1, 5, 5]
    expect(pickCut(sizes, levels, 0, rule)).toBe(4)
  })

  it('counts only the audio after the last cut', () => {
    const sizes = [100, 100, 100, 100, 100, 100, 100, 100, 100]
    const levels = [9, 9, 0, 9, 9, 9, 9, 9, 9]
    expect(pickCut(sizes, levels, 4, rule)).toBeNull()
    expect(pickCut([...sizes, 100], [...levels, 2], 4, rule)).toBe(9)
  })
})
