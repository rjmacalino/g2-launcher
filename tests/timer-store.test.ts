import { describe, expect, it, vi } from 'vitest'

// Same reason as notes-store.test.ts: timer/store.ts imports platform/bridge.ts,
// which does a top-level await against the real bridge. Mocked so the import
// does not hang; none of the functions under test touch bridge or status.
vi.mock('../src/platform/bridge', () => ({
  bridge: {},
  status: vi.fn(),
}))

const { remainingMs, isExpired, startTimer, pauseTimer, resumeTimer, cancelTimer } =
  await import('../src/features/timer/store')

const NOW = 1_000_000

describe('remainingMs', () => {
  it('is zero for an idle timer', () => {
    expect(remainingMs({ status: 'idle' }, NOW)).toBe(0)
  })

  it('derives from endTimestamp for a running timer', () => {
    expect(remainingMs({ status: 'running', endTimestamp: NOW + 5000 }, NOW)).toBe(5000)
  })

  it('clamps a running timer past its end to zero, not negative', () => {
    expect(remainingMs({ status: 'running', endTimestamp: NOW - 5000 }, NOW)).toBe(0)
  })

  it('reads the frozen snapshot for a paused timer regardless of now', () => {
    expect(remainingMs({ status: 'paused', remainingMs: 5000 }, NOW + 999_999)).toBe(5000)
  })
})

describe('isExpired', () => {
  it('is false for idle and paused', () => {
    expect(isExpired({ status: 'idle' }, NOW)).toBe(false)
    expect(isExpired({ status: 'paused', remainingMs: 0 }, NOW)).toBe(false)
  })

  it('is true once a running timer reaches its endTimestamp', () => {
    expect(isExpired({ status: 'running', endTimestamp: NOW }, NOW)).toBe(true)
    expect(isExpired({ status: 'running', endTimestamp: NOW - 1 }, NOW)).toBe(true)
  })

  it('is false for a running timer with time left', () => {
    expect(isExpired({ status: 'running', endTimestamp: NOW + 1 }, NOW)).toBe(false)
  })
})

describe('startTimer', () => {
  it('produces a running state ending duration ms from now', () => {
    expect(startTimer(60_000, NOW)).toEqual({ status: 'running', endTimestamp: NOW + 60_000 })
  })
})

describe('pauseTimer', () => {
  it("freezes a running timer's remaining time", () => {
    const running = startTimer(60_000, NOW)
    expect(pauseTimer(running, NOW + 20_000)).toEqual({ status: 'paused', remainingMs: 40_000 })
  })

  it('is a no-op on an idle timer', () => {
    expect(pauseTimer({ status: 'idle' }, NOW)).toEqual({ status: 'idle' })
  })

  it('is a no-op on an already-paused timer', () => {
    const paused: { status: 'paused'; remainingMs: number } = {
      status: 'paused',
      remainingMs: 1000,
    }
    expect(pauseTimer(paused, NOW)).toEqual(paused)
  })
})

describe('resumeTimer', () => {
  it('recomputes endTimestamp from the current clock, not a stale one', () => {
    const paused = pauseTimer(startTimer(60_000, NOW), NOW + 20_000)
    // Resumed much later than it was paused - the snapshot (40s) should be
    // measured against the resume time, not the original start time.
    expect(resumeTimer(paused, NOW + 500_000)).toEqual({
      status: 'running',
      endTimestamp: NOW + 500_000 + 40_000,
    })
  })

  it('is a no-op on a running timer', () => {
    const running = startTimer(60_000, NOW)
    expect(resumeTimer(running, NOW + 1000)).toEqual(running)
  })

  it('is a no-op on an idle timer', () => {
    expect(resumeTimer({ status: 'idle' }, NOW)).toEqual({ status: 'idle' })
  })
})

describe('cancelTimer', () => {
  it('returns idle', () => {
    expect(cancelTimer()).toEqual({ status: 'idle' })
  })
})
