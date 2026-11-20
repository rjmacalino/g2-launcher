import { describe, expect, it } from 'vitest'
import {
  isSilenceHallucination,
  stripNonSpeech,
  stripWakePhrase,
  worthAsking,
} from '../src/shared/transcript'

describe('stripNonSpeech', () => {
  it('drops bracketed and parenthesised non-speech markers', () => {
    expect(stripNonSpeech(' [BLANK_AUDIO] hello (upbeat music)  there [Music]')).toBe('hello there')
  })
})

describe('isSilenceHallucination', () => {
  it('catches what Whisper invents from room noise', () => {
    expect(isSilenceHallucination('You')).toBe(true)
    expect(isSilenceHallucination(' you. ')).toBe(true)
    expect(isSilenceHallucination('Thanks for watching!')).toBe(true)
  })

  it('leaves real speech alone, including a plain thank you', () => {
    expect(isSilenceHallucination('Thank you')).toBe(false)
    expect(isSilenceHallucination('you said five minutes')).toBe(false)
  })
})

describe('stripWakePhrase', () => {
  it('removes the wake phrase however Whisper punctuates it', () => {
    expect(stripWakePhrase('Hey Jarvis, set a timer for five minutes.')).toBe(
      'set a timer for five minutes.',
    )
    expect(stripWakePhrase('Hey, Jarvis. What is the weather?')).toBe('What is the weather?')
    expect(stripWakePhrase('hey jervis add milk')).toBe('add milk')
  })

  it('also drops the tail of what was said before it', () => {
    expect(stripWakePhrase('thanks a lot. Hey Jarvis, what time is it?')).toBe('what time is it?')
  })

  it('leaves a transcript with no wake phrase alone', () => {
    expect(stripWakePhrase('What is the capital of Australia?')).toBe(
      'What is the capital of Australia?',
    )
  })

  it('only looks near the start', () => {
    const text = 'Tell me about the movie where Tony Stark talks to Jarvis'
    expect(stripWakePhrase(text)).toBe(text)
  })

  it('can leave nothing when only the wake phrase was said', () => {
    expect(stripWakePhrase('Hey Jarvis.')).toBe('')
  })
})

describe('worthAsking (G2-202)', () => {
  it('never sends fillers, noise or an empty transcript', () => {
    for (const heard of [
      '',
      'Um.',
      'Okay, thank you.',
      'uh, yeah',
      'Thanks for watching!',
      'Hello?',
    ]) {
      expect(worthAsking(heard, false)).toBe(false)
      expect(worthAsking(heard, true)).toBe(false)
    }
  })

  it('needs two real words to start a chat, one for a follow-up', () => {
    expect(worthAsking('Why?', false)).toBe(false)
    expect(worthAsking('Why?', true)).toBe(true)
    expect(worthAsking('Reverse a string', false)).toBe(true)
    expect(worthAsking('Tell me about yourself.', false)).toBe(true)
  })
})
