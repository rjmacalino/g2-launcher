import { afterEach, describe, expect, it, vi } from 'vitest'
// paging.ts measures text through platform/page, which loads the bridge.
vi.mock('../src/platform/bridge', () => ({
  bridge: {},
  status: vi.fn(),
}))

const { listeningHeader, listeningText, startTicker, stopTicker, tickerRunning } =
  await import('../src/features/chat/listeningScreen')
const { SCREEN_ROWS } = await import('../src/features/chat/paging')

// The listening screen (G2-157, G2-158, G2-164, split out in G2-174).

describe('listeningHeader', () => {
  it('names the engine and counts, on one line: how to send is on the hint row', () => {
    expect(listeningHeader({ engine: 'Gemini Live', dots: '..', seconds: 4 })).toBe(
      'Gemini Live listening.. (4s)',
    )
  })

  it('flags an engine that is not connected', () => {
    expect(
      listeningHeader({ engine: 'Gemini Live (not connected)', dots: '.', seconds: 1 }),
    ).toMatch(/^Gemini Live \(not connected\) listening/)
  })
})

describe('listeningText', () => {
  it('is just the header before any words are heard', () => {
    expect(listeningText('H1\nH2', '')).toBe('H1\nH2')
  })

  it('keeps the newest caption rows that fit under the header', () => {
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ')
    const text = listeningText('H1\nH2', words)
    const lines = text.split('\n')
    expect(lines).toHaveLength(SCREEN_ROWS)
    expect(lines.slice(0, 3)).toEqual(['H1', 'H2', ''])
    expect(text.endsWith('word199')).toBe(true)
  })
})

describe('startTicker', () => {
  afterEach(() => {
    stopTicker()
    vi.useRealTimers()
  })

  it('draws at once and every second, and only one runs at a time', () => {
    vi.useFakeTimers()
    const first: number[] = []
    const second: number[] = []
    startTicker(
      () => false,
      (_, s) => first.push(s),
    )
    vi.advanceTimersByTime(2000)
    expect(first).toEqual([0, 1, 2])
    startTicker(
      () => false,
      (_, s) => second.push(s),
    )
    vi.advanceTimersByTime(1000)
    expect(first).toHaveLength(3)
    expect(second).toEqual([0, 1])
  })

  it('stops itself once stale', () => {
    vi.useFakeTimers()
    let stale = false
    const drawn: number[] = []
    startTicker(
      () => stale,
      (_, s) => drawn.push(s),
    )
    stale = true
    vi.advanceTimersByTime(3000)
    expect(drawn).toEqual([0])
    expect(tickerRunning()).toBe(false)
  })
})
