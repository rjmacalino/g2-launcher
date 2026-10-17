import { describe, expect, it } from 'vitest'
import { createCuePolicy, parseCue, transcriptForCue } from '../src/features/live/cues'

describe('parseCue', () => {
  it('reads NONE, in any of its forms, as nothing to show', () => {
    expect(parseCue('NONE')).toBeNull()
    expect(parseCue(' none.')).toBeNull()
    expect(parseCue('NONE - nothing useful to add')).toBeNull()
    expect(parseCue('')).toBeNull()
  })

  it('strips quotes and a label', () => {
    expect(parseCue('"Ask what she liked most about Kyoto"')).toBe(
      'Ask what she liked most about Kyoto',
    )
    expect(parseCue('Cue: Use a hash map, one pass, O(n)')).toBe('Use a hash map, one pass, O(n)')
  })

  it('strips curly quotes too', () => {
    expect(parseCue('\u201cAsk about her team\u201d')).toBe('Ask about her team')
  })

  it('keeps a cue that merely starts with a word like "nonetheless"', () => {
    expect(parseCue('Nonetheless, mention the March deadline')).toBe(
      'Nonetheless, mention the March deadline',
    )
  })

  it('clips an over-long reply to fit the glasses', () => {
    const cue = parseCue('word '.repeat(40))!
    expect(cue.length).toBeLessThanOrEqual(90)
    expect(cue.endsWith('...')).toBe(true)
  })
})

describe('transcriptForCue', () => {
  it('labels speakers and keeps the newest lines that fit', () => {
    const lines = [
      ...Array.from({ length: 60 }, (_, i) => ({
        speaker: 'other',
        text: `old line ${i} `.repeat(3),
        at: i,
      })),
      { speaker: 'other', text: 'What is your budget?', at: 100 },
    ]
    const text = transcriptForCue(lines)
    expect(text.endsWith('Them: What is your budget?')).toBe(true)
    expect(text).not.toContain('old line 0 ')
    expect(text.length).toBeLessThan(1700)
  })
})

describe('createCuePolicy', () => {
  it('asks at once when the other person asks a question', () => {
    const policy = createCuePolicy()
    expect(policy.onLine('How long have you worked in fintech?', 1000)).toBe(true)
  })

  it('does not ask on every line of small talk', () => {
    const policy = createCuePolicy()
    policy.started(0)
    policy.finished()
    expect(policy.onLine('It was a long drive.', 3000)).toBe(false)
    expect(policy.onLine('We stopped for lunch on the way.', 8000)).toBe(false)
  })

  it('asks after enough new conversation and enough time', () => {
    const policy = createCuePolicy()
    policy.started(0)
    policy.finished()
    const long = 'We spent most of the time in Kyoto and visited a lot of temples.'
    expect(policy.onLine(long, 10_000)).toBe(false)
    expect(policy.onLine(long, 16_000)).toBe(true)
  })

  it('never has two requests in flight, but remembers a question asked meanwhile', () => {
    const policy = createCuePolicy()
    policy.started(0)
    expect(policy.onLine('Can you send me the report?', 7000)).toBe(false)
    policy.finished()
    expect(policy.onTick(7100)).toBe(true)
  })

  it('holds even a tap until the minimum gap has passed', () => {
    const policy = createCuePolicy()
    policy.started(0)
    policy.finished()
    expect(policy.onTap(2000)).toBe(false)
    expect(policy.onTick(6000)).toBe(true)
  })
})
