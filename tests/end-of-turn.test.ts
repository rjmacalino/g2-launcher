import { describe, expect, it } from 'vitest'
import {
  COMPLETE_PAUSE_MS,
  INCOMPLETE_PAUSE_MS,
  createTurnDetector,
  soundsFinished,
} from '../src/shared/endOfTurn'
import { parseAutoSend } from '../src/shared/autoSend'

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

  // Auto-send as voiceCapture sets it up (G2-158): one pause for every
  // question, and Infinity when it is off.
  function quietUntilSent(pauseMs: number): number {
    const turn = createTurnDetector({
      initialFloor: QUIET,
      completePauseMs: pauseMs,
      incompletePauseMs: pauseMs,
    })
    for (let i = 0; i < 10; i++) turn.push(LOUD, 'What is a closure?')
    for (let ms = 100; ms <= 60_000; ms += 100) {
      if (turn.push(QUIET, 'What is a closure?') !== 'listening') return ms
    }
    return -1
  }

  it('auto-send after 10 s waits 10 s of quiet even for a finished question', () => {
    expect(quietUntilSent(10_000)).toBe(10_000)
  })

  it('counts real frame time: 20 s with 10 ms frames waits 20 s, not 2 s (G2-162)', () => {
    const turn = createTurnDetector({
      initialFloor: QUIET,
      completePauseMs: 20_000,
      incompletePauseMs: 20_000,
    })
    for (let i = 0; i < 100; i++) turn.push(LOUD, 'What is a closure?', 10)
    let ms = 0
    while (turn.push(QUIET, 'What is a closure?', 10) === 'listening') ms += 10
    expect(ms + 10).toBe(20_000)
  })

  it('auto-send off never sends on quiet; only a tap ends the recording', () => {
    expect(quietUntilSent(Infinity)).toBe(-1)
  })

  it('auto-send off still stops a recording where nothing is said', () => {
    const turn = createTurnDetector({
      initialFloor: QUIET,
      completePauseMs: Infinity,
      incompletePauseMs: Infinity,
    })
    let decision = 'listening'
    for (let i = 0; i < 60 && decision === 'listening'; i++) decision = turn.push(QUIET, '')
    expect(decision).toBe('no-speech')
  })

  it('reads the saved auto-send choice, anything unknown as off', () => {
    expect(parseAutoSend('10')).toBe(10)
    expect(parseAutoSend('20')).toBe(20)
    expect(parseAutoSend('')).toBe(0)
    expect(parseAutoSend('7')).toBe(0)
    expect(parseAutoSend('0')).toBe(0)
  })

  it('gives up when nothing is said at all', () => {
    const turn = createTurnDetector({ initialFloor: QUIET })
    let decision = 'listening'
    for (let i = 0; i < 60 && decision === 'listening'; i++) decision = turn.push(QUIET, '')
    expect(decision).toBe('no-speech')
  })
})
