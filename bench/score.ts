// Pure scoring helpers for the benchmark, unit-tested in tests/bench.test.ts.

export type Verdict = 'pass' | 'fail' | 'review'

// expect is a list of groups; every group must match, and a group matches
// when the answer contains any one of its alternatives (case-insensitive).
// An empty list means no automatic check is meaningful (open-ended small
// talk, interview phrasing): the answer is printed for a human to judge.
export function scoreAnswer(answer: string, expect: readonly (readonly string[])[]): Verdict {
  if (expect.length === 0) return 'review'
  const text = answer.toLowerCase()
  const allMatch = expect.every(group => group.some(option => text.includes(option.toLowerCase())))
  return allMatch ? 'pass' : 'fail'
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

// Word error rate: the fewest word insertions, deletions and substitutions
// that turn what Whisper heard into what was said, divided by the number
// of words said. 0 is perfect. Numbers are compared as written, so "five"
// heard for "5" counts as an error - the question texts avoid digits for
// that reason.
export function wordErrorRate(reference: string, heard: string): number {
  const ref = words(reference)
  const hyp = words(heard)
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1
  let previous = Array.from({ length: hyp.length + 1 }, (_, j) => j)
  for (let i = 1; i <= ref.length; i++) {
    const current = [i]
    for (let j = 1; j <= hyp.length; j++) {
      const substitution = previous[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution)
    }
    previous = current
  }
  return previous[hyp.length] / ref.length
}

// Reads a RIFF/WAVE file's PCM data, refusing anything that is not what
// the glasses mic delivers (16 kHz, mono, 16-bit), so the benchmark feeds
// Whisper exactly the shape of audio it gets in real use.
export function readWavPcm(file: Uint8Array): Uint8Array {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  const tag = (offset: number) => String.fromCharCode(...file.subarray(offset, offset + 4))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file')
  let offset = 12
  let format: { channels: number; rate: number; bits: number } | null = null
  while (offset + 8 <= file.length) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      format = {
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      }
    } else if (id === 'data') {
      if (!format) throw new Error('WAV data before format')
      if (format.channels !== 1 || format.rate !== 16000 || format.bits !== 16) {
        throw new Error(
          `WAV is ${format.rate} Hz, ${format.channels} channel(s), ${format.bits}-bit; need 16000 Hz mono 16-bit`,
        )
      }
      return file.subarray(body, Math.min(body + size, file.length))
    }
    offset = body + size + (size % 2)
  }
  throw new Error('WAV has no data')
}
