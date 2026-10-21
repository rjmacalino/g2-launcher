import { describe, expect, it } from 'vitest'
import { positionLabel } from '../src/shared/position'

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
