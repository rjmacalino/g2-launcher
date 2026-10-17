import { describe, expect, it } from 'vitest'
import { isSilenceHallucination, stripNonSpeech } from '../src/shared/transcript'

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
