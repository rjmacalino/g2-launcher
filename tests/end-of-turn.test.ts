import { describe, expect, it } from 'vitest'
import {
  COMPLETE_PAUSE_MS,
  INCOMPLETE_PAUSE_MS,
  createTurnDetector,
  soundsFinished,
} from '../src/shared/endOfTurn'

const LOUD = 0.2
const QUIET = 0.002

// Speaks for a second, then stays quiet; returns how long the quiet lasted
// until the detector said 'finished' (or -1 if it never did within 10 s).
function quietUntilFinished(transcript: string | null): number {
  const turn = createTurnDetector({ initialFloor: QUIET })
  for (let i = 0; i < 10; i++) turn.push(LOUD, transcript)
  for (let ms = 100; ms <= 10_000; ms += 100) {
    if (turn.push(QUIET, transcript) === 'finished') return ms
  }
  return -1
}

describe('soundsFinished (G2-149)', () => {
  it('reads a punctuated question or sentence as finished', () => {
    expect(soundsFinished('How do I reverse a string in JavaScript?')).toBe(true)
    expect(soundsFinished('Tell me about yourself.')).toBe(true)
  })

  it('reads trailing words, fillers and missing punctuation as unfinished', () => {
    expect(soundsFinished('How do I loop over an array and')).toBe(false)
    expect(soundsFinished('So um.')).toBe(false)
    expect(soundsFinished('Compare it with the.')).toBe(false)
    expect(soundsFinished('')).toBe(false)
  })
})

describe('createTurnDetector (G2-149)', () => {
  it('sends a finished question after the short pause', () => {
    expect(quietUntilFinished('What is a closure?')).toBe(COMPLETE_PAUSE_MS)
  })

  it('waits the long pause when the question trails off', () => {
    expect(quietUntilFinished('Given an array of numbers and')).toBe(INCOMPLETE_PAUSE_MS)
  })

  it('uses the long pause without a live transcript (Whisper)', () => {
    expect(quietUntilFinished(null)).toBe(INCOMPLETE_PAUSE_MS)
  })

  it('starts the wait again when new words arrive during the pause', () => {
    const turn = createTurnDetector({ initialFloor: QUIET })
    for (let i = 0; i < 10; i++) turn.push(LOUD, 'Write a function')
    for (let i = 0; i < 30; i++) expect(turn.push(QUIET, 'Write a function')).toBe('listening')
    // Quiet mic, but the transcript grew: the wearer is still talking.
    expect(turn.push(QUIET, 'Write a function that sums an array.')).toBe('listening')
    let ms = 0
    while (turn.push(QUIET, 'Write a function that sums an array.') !== 'finished') ms += 100
    expect(ms + 100).toBe(COMPLETE_PAUSE_MS)
  })

  it('gives up when nothing is said at all', () => {
    const turn = createTurnDetector({ initialFloor: QUIET })
    let decision = 'listening'
    for (let i = 0; i < 60 && decision === 'listening'; i++) decision = turn.push(QUIET, '')
    expect(decision).toBe('no-speech')
  })
})
