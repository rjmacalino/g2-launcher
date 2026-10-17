import { describe, expect, it } from 'vitest'
import { bytesToSeconds, concat, toFloat32 } from '../src/shared/pcm'

describe('toFloat32', () => {
  it('reads little-endian signed 16-bit samples into [-1, 1]', () => {
    // 0x0000 = 0, 0x4000 = 16384 (0.5), 0x8000 = -32768 (-1), 0xffff = -1
    const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x40, 0x00, 0x80, 0xff, 0xff])
    expect(Array.from(toFloat32(bytes))).toEqual([0, 0.5, -1, -1 / 32768])
  })

  it('ignores a trailing odd byte rather than reading past the end', () => {
    expect(toFloat32(new Uint8Array([0x00, 0x40, 0x7f])).length).toBe(1)
  })

  it('respects a view that starts partway into its buffer', () => {
    const buffer = new Uint8Array([0xaa, 0x00, 0x40]).buffer
    expect(Array.from(toFloat32(new Uint8Array(buffer, 1, 2)))).toEqual([0.5])
  })
})

describe('concat', () => {
  it('joins chunks in order', () => {
    const joined = concat([new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3])])
    expect(Array.from(joined)).toEqual([1, 2, 3])
  })
})

describe('bytesToSeconds', () => {
  it('one 100 ms mic event is 3200 bytes', () => {
    expect(bytesToSeconds(3200)).toBeCloseTo(0.1)
  })
})
