import { describe, expect, it } from 'vitest'
import { positionLabel, screenRange } from '../src/shared/position'

describe('positionLabel (G2-102)', () => {
  it('shows nothing when there is only one place', () => {
    expect(positionLabel(0, 1)).toBeNull()
    expect(positionLabel(0, 0)).toBeNull()
  })

  it('says which page of how many', () => {
    expect(positionLabel(0, 3)).toBe('Page 1 of 3')
    expect(positionLabel(2, 3)).toBe('Page 3 of 3')
    expect(positionLabel(11, 20)).toBe('Page 12 of 20')
  })

  it('keeps a bad index on a real page', () => {
    expect(positionLabel(9, 3)).toBe('Page 3 of 3')
    expect(positionLabel(-2, 3)).toBe('Page 1 of 3')
  })
})

describe('screenRange (G2-112)', () => {
  it('shows nothing when the answer fits one screen', () => {
    expect(screenRange(0, 6, 6, 8)).toBeNull()
  })

  it('names a single screen or a range of them', () => {
    expect(screenRange(32, 40, 40, 8)).toBe('Page 5 of 5')
    expect(screenRange(8, 32, 40, 8)).toBe('Pages 2-4 of 5')
    expect(screenRange(0, 24, 24, 8)).toBe('Pages 1-3 of 3')
  })

  it('keeps odd rows on a real screen', () => {
    expect(screenRange(41, 60, 40, 8)).toBe('Page 5 of 5')
    expect(screenRange(-3, 4, 40, 8)).toBe('Page 1 of 5')
  })
})
