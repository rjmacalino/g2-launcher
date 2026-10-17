import { describe, expect, it } from 'vitest'
import { createEndpointer, endsInSpeech, rmsLevel } from '../src/shared/endpoint'

const QUIET = 0.002
const SPEECH = 0.05

function feed(levels: number[], options = {}) {
  const endpointer = createEndpointer({ initialFloor: QUIET, ...options })
  const decisions = levels.map(level => endpointer.push(level))
  const end = decisions.findIndex(d => d !== 'listening')
  return { decision: end === -1 ? 'listening' : decisions[end], atFrame: end }
}

const repeat = (level: number, frames: number) => Array<number>(frames).fill(level)

describe('createEndpointer', () => {
  it('finishes after 1.2 s of quiet following speech', () => {
    const { decision, atFrame } = feed([...repeat(SPEECH, 10), ...repeat(QUIET, 20)])
    expect(decision).toBe('finished')
    expect(atFrame).toBe(10 + 12 - 1)
  })

  it('keeps listening through a short pause mid-sentence', () => {
    const levels = [...repeat(SPEECH, 10), ...repeat(QUIET, 8), ...repeat(SPEECH, 10)]
    expect(feed(levels).decision).toBe('listening')
  })

  it('gives up when nobody speaks', () => {
    const { decision, atFrame } = feed(repeat(QUIET, 80))
    expect(decision).toBe('no-speech')
    expect(atFrame).toBe(59)
  })

  it('does not count a single loud frame as speech', () => {
    const { decision } = feed([SPEECH, ...repeat(QUIET, 70)])
    expect(decision).toBe('no-speech')
  })

  it('judges speech against a noisy room, not a fixed level', () => {
    const room = 0.03
    const levels = [...repeat(room, 10), ...repeat(0.12, 10), ...repeat(room, 15)]
    const endpointer = createEndpointer({ initialFloor: room })
    const decisions = levels.map(level => endpointer.push(level))
    expect(decisions).toContain('finished')
  })

  it('stops a recording that never goes quiet', () => {
    expect(feed(repeat(SPEECH, 250)).decision).toBe('too-long')
  })
})

describe('rmsLevel', () => {
  it('is the root mean square', () => {
    expect(rmsLevel(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5)
    expect(rmsLevel(new Float32Array(0))).toBe(0)
  })
})

describe('alreadySpeaking and endsInSpeech', () => {
  it('ends after quiet when the wearer was mid-sentence at the start', () => {
    const endpointer = createEndpointer({ initialFloor: QUIET, alreadySpeaking: true })
    const decisions = repeat(QUIET, 15).map(level => endpointer.push(level))
    expect(decisions[11]).toBe('finished')
  })

  it('tells speech at the end of the preroll from a pause after the wake word', () => {
    expect(endsInSpeech([QUIET, SPEECH, SPEECH, QUIET, SPEECH, SPEECH, SPEECH])).toBe(true)
    expect(endsInSpeech([QUIET, SPEECH, SPEECH, SPEECH, QUIET, QUIET, QUIET])).toBe(false)
  })
})

describe('rmsLevel with a DC offset', () => {
  it('measures the sound around the average, not the offset', () => {
    const offset = 150 / 32768
    const silent = new Float32Array(1600).fill(offset)
    expect(rmsLevel(silent)).toBe(0)
    const tone = silent.map((v, i) => v + (i % 2 === 0 ? 0.01 : -0.01))
    expect(rmsLevel(tone)).toBeCloseTo(0.01)
  })
})
