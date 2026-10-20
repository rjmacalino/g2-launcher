import { describe, expect, it } from 'vitest'
import { positionLabel } from '../src/shared/position'

describe('positionLabel (G2-102)', () => {
  it('shows nothing when there is only one place', () => {
    expect(positionLabel(0, 1)).toBeNull()
    expect(positionLabel(0, 0)).toBeNull()
  })

  it('numbers the place and moves a marker along the bar', () => {
    expect(positionLabel(0, 3)).toBe('1/3 [|-------]')
    expect(positionLabel(1, 3)).toBe('2/3 [----|---]')
    expect(positionLabel(2, 3)).toBe('3/3 [-------|]')
  })

  it('keeps a bad index on the bar', () => {
    expect(positionLabel(9, 3)).toBe('3/3 [-------|]')
    expect(positionLabel(-2, 3)).toBe('1/3 [|-------]')
  })
})
