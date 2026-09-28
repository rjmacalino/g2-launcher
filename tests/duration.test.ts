import { describe, expect, it } from 'vitest'
import { formatDuration } from '../src/shared/duration'

describe('formatDuration', () => {
  it('formats under an hour as m:ss', () => {
    expect(formatDuration(5 * 60_000)).toBe('5:00')
    expect(formatDuration(65_000)).toBe('1:05')
  })

  it('formats an hour or more as h:mm:ss', () => {
    expect(formatDuration(60 * 60_000)).toBe('1:00:00')
    expect(formatDuration(9 * 60 * 60_000 + 59 * 60_000 + 59_000)).toBe('9:59:59')
  })

  it('rounds up to the next whole second rather than truncating', () => {
    expect(formatDuration(500)).toBe('0:01')
  })

  it('formats zero as zero, not empty', () => {
    expect(formatDuration(0)).toBe('0:00')
  })
})
