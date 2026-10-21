import { describe, expect, it } from 'vitest'
import {
  parseAnswer,
  splitQuestion,
  transcriptFor,
  triggersAnswer,
} from '../src/features/parakeet/answer'

describe('parseAnswer (G2-128)', () => {
  it('keeps a real answer, trimmed', () => {
    expect(parseAnswer('  Use a hash map.  ')).toBe('Use a hash map.')
  })

  it('treats NONE, in any case, and an empty reply as nothing to answer', () => {
    expect(parseAnswer('NONE')).toBeNull()
    expect(parseAnswer(' none. ')).toBeNull()
    expect(parseAnswer('')).toBeNull()
  })
})

describe('transcriptFor', () => {
  it('labels the speakers and keeps the order', () => {
    const text = transcriptFor([
      { speaker: 'other', text: 'Reverse a string.', at: 1 },
      { speaker: 'self', text: 'Sure.', at: 2 },
      { speaker: 'unknown', text: 'Go on.', at: 3 },
    ])
    expect(text).toBe('Them: Reverse a string.\nMe: Sure.\nGo on.')
  })

  it('keeps the newest lines when the talk is long', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => ({
      speaker: 'other',
      text: `line number ${i}`,
      at: i,
    }))
    const text = transcriptFor(lines)
    expect(text.endsWith('line number 999')).toBe(true)
    expect(text.startsWith('Them: line number 0')).toBe(false)
  })
})

describe('transcriptFor, handled lines', () => {
  const lines = [
    { speaker: 'other', text: 'Reverse a string.', at: 1 },
    { speaker: 'self', text: 'I would loop backwards.', at: 2 },
    { speaker: 'other', text: 'Now do it in place.', at: 3 },
  ]

  it('sets the lines already dealt with apart from the new ones', () => {
    const expected = [
      'Earlier:',
      'Them: Reverse a string.',
      'Me: I would loop backwards.',
      '',
      'New:',
      'Them: Now do it in place.',
    ].join('\n')
    expect(transcriptFor(lines, 2)).toBe(expected)
  })

  it('says so when nothing is new', () => {
    expect(transcriptFor(lines, 3)).toContain('(nothing new)')
  })
})

describe('splitQuestion (G2-132)', () => {
  it('takes the question off the first line', () => {
    expect(splitQuestion('Q: What do you do for fun?\nI hike on weekends.', 'x')).toEqual({
      question: 'What do you do for fun?',
      answer: 'I hike on weekends.',
    })
  })

  it('keeps a reply without a question line whole, with the fallback question', () => {
    expect(splitQuestion('I hike on weekends.', 'fun?')).toEqual({
      question: 'fun?',
      answer: 'I hike on weekends.',
    })
  })

  it('does not take a question line that has no answer under it', () => {
    expect(splitQuestion('Q: Only a question', 'q').answer).toBe('Q: Only a question')
  })
})

describe('triggersAnswer', () => {
  it('waits for a few words from anyone', () => {
    expect(triggersAnswer({ speaker: 'other', text: 'Can you reverse a list', at: 1 })).toBe(true)
    expect(triggersAnswer({ speaker: 'unknown', text: 'Given an array of numbers', at: 1 })).toBe(
      true,
    )
    // The glasses' speaker guess is not trusted (G2-133): the model decides.
    expect(triggersAnswer({ speaker: 'self', text: 'What do you do', at: 1 })).toBe(true)
    expect(triggersAnswer({ speaker: 'other', text: 'Okay', at: 1 })).toBe(false)
  })
})
