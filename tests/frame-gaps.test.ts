import { describe, expect, it } from 'vitest'
import { createFrameTracker } from '../src/shared/frameGaps'

describe('createFrameTracker', () => {
  it('counts only gaps longer than the threshold, and keeps the longest', () => {
    const frames = createFrameTracker(300)
    for (const at of [0, 100, 200, 700, 800, 1200]) frames.onFrame(at)
    expect(frames.gapCount()).toBe(2)
    expect(frames.longestGapMs()).toBe(500)
  })

  it('reports nothing before a second frame arrives', () => {
    const frames = createFrameTracker(300)
    frames.onFrame(5000)
    expect(frames.gapCount()).toBe(0)
    expect(frames.longestGapMs()).toBe(0)
  })
})
