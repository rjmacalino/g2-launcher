import { describe, expect, it, vi } from 'vitest'

// paging.ts (through viewer.ts) needs the glasses bridge's geometry; mocked as
// in the other paging tests.
vi.mock('../src/platform/bridge', () => ({
  bridge: {},
  status: vi.fn(),
}))

const { SCREEN_ROWS } = await import('../src/features/chat/paging')
const { slideFrames } = await import('../src/features/chat/viewer')

const old = Array.from({ length: 12 }, (_, i) => `old ${i}`)
const fresh = Array.from({ length: 12 }, (_, i) => `new ${i}`)
const split = (frames: string[]) => frames.map(f => f.split('\n'))

describe('slideFrames (G2-113)', () => {
  it('moves the old screen up as the new one rises in, going on', () => {
    const frames = split(slideFrames(old, fresh, 1))
    expect(frames).toHaveLength(Math.floor((SCREEN_ROWS - 1) / 2))
    // First frame: two old rows gone, two new rows entering at the bottom.
    expect(frames[0]).toEqual([...old.slice(-SCREEN_ROWS + 2), 'new 0', 'new 1'])
    for (const f of frames) expect(f).toHaveLength(SCREEN_ROWS)
    const newRows = (f: string[]) => f.filter(r => r.startsWith('new')).length
    expect(newRows(frames[frames.length - 1])).toBeGreaterThan(newRows(frames[0]))
  })

  it('brings the new screen down from above, going back', () => {
    const frames = split(slideFrames(old, fresh, -1))
    expect(frames[0]).toEqual([
      `new ${SCREEN_ROWS - 2}`,
      `new ${SCREEN_ROWS - 1}`,
      ...old.slice(0, SCREEN_ROWS - 2),
    ])
  })

  it('pads a short page instead of failing', () => {
    const frames = split(slideFrames(['only'], ['next'], 1))
    expect(frames.every(f => f.length === SCREEN_ROWS)).toBe(true)
  })
})
