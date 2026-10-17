import { describe, expect, it } from 'vitest'
import { createSegmenter, type Segment } from '../src/features/live/segmenter'

const QUIET = 0.002
const SPEECH = 0.05

// Feeds levels as 100 ms frames; each frame's pcm holds its index so a
// test can see exactly which frames ended up in which segment.
function run(levels: number[], speakers?: string[], options = {}) {
  const segmenter = createSegmenter(options)
  const segments: Segment[] = []
  levels.forEach((level, i) => {
    const segment = segmenter.push(new Uint8Array([i]), level, speakers?.[i] ?? 'unknown', i * 100)
    if (segment) segments.push(segment)
  })
  const rest = segmenter.flush(levels.length * 100)
  if (rest) segments.push(rest)
  return segments.map(s => ({ frames: s.frames.map(f => f[0]), speaker: s.speaker }))
}

const repeat = (level: number, n: number) => Array<number>(n).fill(level)

describe('createSegmenter', () => {
  it('sends nothing for silence', () => {
    expect(run(repeat(QUIET, 100))).toEqual([])
  })

  it('cuts at a pause, with a little lead-in before the speech', () => {
    const levels = [...repeat(QUIET, 10), ...repeat(SPEECH, 10), ...repeat(QUIET, 10)]
    const [segment, ...others] = run(levels)
    expect(others).toEqual([])
    // Lead-in: the 3 frames before the two loud ones that confirmed speech.
    expect(segment.frames[0]).toBe(7)
    // Ends after 7 quiet frames (700 ms).
    expect(segment.frames[segment.frames.length - 1]).toBe(26)
  })

  it('keeps one segment through a short breath', () => {
    const levels = [
      ...repeat(QUIET, 5),
      ...repeat(SPEECH, 10),
      ...repeat(QUIET, 4),
      ...repeat(SPEECH, 10),
      ...repeat(QUIET, 10),
    ]
    expect(run(levels)).toHaveLength(1)
  })

  it('makes two segments from two sentences', () => {
    const levels = [
      ...repeat(QUIET, 5),
      ...repeat(SPEECH, 10),
      ...repeat(QUIET, 10),
      ...repeat(SPEECH, 10),
      ...repeat(QUIET, 10),
    ]
    expect(run(levels)).toHaveLength(2)
  })

  it('cuts a long monologue into pieces and keeps going', () => {
    const segments = run([...repeat(QUIET, 5), ...repeat(SPEECH, 300)])
    expect(segments.length).toBeGreaterThanOrEqual(2)
    expect(segments[0].frames.length).toBe(120)
  })

  it('labels a segment with whoever spoke most of it', () => {
    const levels = [...repeat(QUIET, 5), ...repeat(SPEECH, 10), ...repeat(QUIET, 10)]
    const speakers = [...Array(8).fill('unknown'), ...Array(17).fill('other')]
    expect(run(levels, speakers)[0].speaker).toBe('other')
  })

  it('hands over speech still going when Live stops', () => {
    expect(run([...repeat(QUIET, 5), ...repeat(SPEECH, 6)])).toHaveLength(1)
  })
})
