import { describe, expect, it } from 'vitest'
import { parseVoiceCommand } from '../src/features/timer/voiceCommand'

describe('parseVoiceCommand', () => {
  it('parses a plain command', () => {
    expect(parseVoiceCommand('timer 5 minutes')).toEqual({
      kind: 'startTimer',
      durationMs: 5 * 60_000,
    })
  })

  it('parses the roadmap phrasing', () => {
    expect(parseVoiceCommand('set a timer for 5 minutes')).toEqual({
      kind: 'startTimer',
      durationMs: 5 * 60_000,
    })
  })

  it('parses "alarm" as a synonym for "timer"', () => {
    expect(parseVoiceCommand('alarm 5 minutes')).toEqual({
      kind: 'startTimer',
      durationMs: 5 * 60_000,
    })
  })

  it('ignores a wake-word style prefix', () => {
    expect(parseVoiceCommand('Jarvis, timer 5 minutes')).toEqual({
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

  it('is unrecognized without the timer/alarm keyword', () => {
    expect(parseVoiceCommand('5 minutes')).toEqual({
      kind: 'unrecognized',
      transcript: '5 minutes',
    })
  })

  it('is unrecognized without a parseable duration', () => {
    expect(parseVoiceCommand('set a timer')).toEqual({
      kind: 'unrecognized',
      transcript: 'set a timer',
    })
  })

  it('is unrecognized for unrelated speech', () => {
    expect(parseVoiceCommand("what's the weather like")).toEqual({
      kind: 'unrecognized',
      transcript: "what's the weather like",
    })
  })

  it('tolerates a mispronunciation Whisper hears as a near-miss word', () => {
    expect(parseVoiceCommand('dimer 5 minutes')).toEqual({
      kind: 'startTimer',
      durationMs: 5 * 60_000,
    })
    expect(parseVoiceCommand('thymer 5 minutes')).toEqual({
      kind: 'startTimer',
      durationMs: 5 * 60_000,
    })
    expect(parseVoiceCommand('timmer 5 minutes')).toEqual({
      kind: 'startTimer',
      durationMs: 5 * 60_000,
    })
  })

  it('does not fuzzy-match short unrelated words', () => {
    expect(parseVoiceCommand('the time is 5 minutes past noon')).toEqual({
      kind: 'unrecognized',
      transcript: 'the time is 5 minutes past noon',
    })
  })
})
