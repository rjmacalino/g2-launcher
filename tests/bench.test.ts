import { describe, expect, it } from 'vitest'
import { readWavPcm, scoreAnswer, wordErrorRate } from '../bench/score'

describe('scoreAnswer', () => {
  it('passes when every group has a match, case-insensitively', () => {
    expect(scoreAnswer('Use a Hash map and a stack', [['hash', 'map'], ['stack']])).toBe('pass')
  })

  it('fails when any group has no match', () => {
    expect(scoreAnswer('Use a hash map', [['hash'], ['stack']])).toBe('fail')
  })

  it('asks for a human when there is nothing to check', () => {
    expect(scoreAnswer('anything', [])).toBe('review')
  })
})

describe('wordErrorRate', () => {
  it('is 0 for a perfect transcript, ignoring case and punctuation', () => {
    expect(
      wordErrorRate('What is the capital of Australia?', 'what is the capital of australia'),
    ).toBe(0)
  })

  it('counts a substitution, a deletion and an insertion against the words said', () => {
    // said 4 words; heard "a" for "the" (1), dropped "of" (1), added "uh" (1)
    expect(wordErrorRate('capital of the country', 'uh capital a country')).toBe(3 / 4)
  })
})

function wav(rate: number, channels: number, bits: number, data: number[]): Uint8Array {
  const out = new Uint8Array(44 + data.length)
  const view = new DataView(out.buffer)
  const put = (offset: number, text: string) =>
    [...text].forEach((c, i) => (out[offset + i] = c.charCodeAt(0)))
  put(0, 'RIFF')
  view.setUint32(4, 36 + data.length, true)
  put(8, 'WAVE')
  put(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, rate, true)
  view.setUint16(34, bits, true)
  put(36, 'data')
  view.setUint32(40, data.length, true)
  out.set(data, 44)
  return out
}

describe('readWavPcm', () => {
  it('returns the data chunk of a 16 kHz mono 16-bit file', () => {
    expect(Array.from(readWavPcm(wav(16000, 1, 16, [1, 2, 3, 4])))).toEqual([1, 2, 3, 4])
  })

  it('refuses audio in a different format than the glasses mic', () => {
    expect(() => readWavPcm(wav(44100, 2, 16, [1, 2]))).toThrow(/16000 Hz mono/)
  })
})
