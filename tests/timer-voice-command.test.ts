import { describe, expect, it } from 'vitest'
import { parseVoiceCommand } from '../src/features/timer/voiceCommand'

describe('parseVoiceCommand', () => {
  it('parses a plain command', () => {
    expect(parseVoiceCommand('timer 5 minutes')).toEqual({
      kind: 'startTimer',
      durationMs: 5 * 60_000,
    })
  })

  it('parses a bare duration with no command verb at all', () => {
    expect(parseVoiceCommand('Jarvis, 5 minutes')).toEqual({
      kind: 'startTimer',
      durationMs: 5 * 60_000,
    })
  })

  it('parses real reported phrasings', () => {
    expect(parseVoiceCommand('Jarvis, set alarm 5 mins')).toEqual({
      kind: 'startTimer',
      durationMs: 5 * 60_000,
    })
    expect(parseVoiceCommand('Jarvis, alarm 5 mins')).toEqual({
      kind: 'startTimer',
      durationMs: 5 * 60_000,
    })
    expect(parseVoiceCommand('Jarvis, can you set a timer for 5 minutes for me.')).toEqual({
      kind: 'startTimer',
      durationMs: 5 * 60_000,
    })
  })

  it('sums hours and minutes regardless of order', () => {
    expect(parseVoiceCommand('timer for 1 hour and 30 minutes')).toEqual({
      kind: 'startTimer',
      durationMs: 90 * 60_000,
    })
    expect(parseVoiceCommand('timer for 30 minutes and 1 hour')).toEqual({
      kind: 'startTimer',
      durationMs: 90 * 60_000,
    })
  })

  it('is case-insensitive', () => {
    expect(parseVoiceCommand('TIMER 5 MINUTES')).toEqual({
      kind: 'startTimer',
      durationMs: 5 * 60_000,
    })
  })

  it('accepts abbreviated units', () => {
    expect(parseVoiceCommand('timer 5 min')).toEqual({ kind: 'startTimer', durationMs: 300_000 })
    expect(parseVoiceCommand('timer 1 hr')).toEqual({
      kind: 'startTimer',
      durationMs: 3_600_000,
    })
  })

  it('tolerates any mispronunciation of the command verb, since none is required', () => {
    expect(parseVoiceCommand('dimer 5 minutes')).toEqual({
      kind: 'startTimer',
      durationMs: 5 * 60_000,
    })
    expect(parseVoiceCommand('thymer 5 minutes')).toEqual({
      kind: 'startTimer',
      durationMs: 5 * 60_000,
    })
  })

  it('is unrecognized without a parseable duration', () => {
    expect(parseVoiceCommand('set a timer')).toEqual({
      kind: 'unrecognized',
      transcript: 'set a timer',
    })
    expect(parseVoiceCommand("what's the weather like")).toEqual({
      kind: 'unrecognized',
      transcript: "what's the weather like",
    })
  })
})
