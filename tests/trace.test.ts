import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createTrace, recordingsOf, replayRecording, type TraceEntry } from '../src/shared/trace'

// Hardware traces (G2-171): what the glasses sent, replayed on the PC.

function fakeClock() {
  let t = 1000
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

// A recording as the glasses would trace it: 10 ms frames, speech then quiet.
function recordedTrace(autoSend: number, speechS: number, quietS: number) {
  const clock = fakeClock()
  const trace = createTrace(100_000, clock.now)
  trace.add({ kind: 'recording-start', autoSend, engine: 'gemini-live' })
  const frames = (rms: number, seconds: number) => {
    for (let i = 0; i < seconds * 100; i++) {
      trace.mic(10, rms)
      clock.advance(10)
    }
  }
  frames(0.002, 0.5)
  frames(0.2, speechS)
  frames(0.002, quietS)
  return trace
}

describe('createTrace', () => {
  it('folds 10 ms mic frames into ~100 ms entries with the loudest level', () => {
    const clock = fakeClock()
    const trace = createTrace(100, clock.now)
    for (let i = 0; i < 10; i++) trace.mic(10, i === 3 ? 0.5 : 0.01)
    const [entry] = trace.entries()
    expect(entry).toMatchObject({ kind: 'mic', ms: 100, frames: 10, rms: 0.5 })
  })

  it('keeps only the newest entries', () => {
    const trace = createTrace(3)
    for (let i = 0; i < 5; i++) trace.add({ kind: 'transcript', chars: i })
    expect(trace.entries().map(e => (e.kind === 'transcript' ? e.chars : -1))).toEqual([2, 3, 4])
  })

  it('serialises without any text: no words, titles or audio', () => {
    const trace = recordedTrace(20, 1, 1)
    trace.add({ kind: 'event', source: 'list', type: 0, container: 'tool', index: 2 })
    trace.add({ kind: 'transcript', chars: 42 })
    const json = trace.toJson()
    expect(JSON.parse(json).version).toBe(1)
    expect(json).not.toMatch(/"text"|"title"|"transcript":"|"audio"/)
  })
})

describe('replayRecording', () => {
  it('reproduces a 20 s auto-send: ends 20 s after the speech stops', () => {
    const [rec] = recordingsOf(recordedTrace(20, 2, 25).entries())
    const result = replayRecording(rec)
    expect(result?.decision).toBe('finished')
    // 0.5 s room + 2 s speech + 20 s quiet, to the nearest 100 ms window.
    expect(result!.atMs).toBeGreaterThanOrEqual(22_400)
    expect(result!.atMs).toBeLessThanOrEqual(22_600)
  })

  it('with auto-send off it never ends on quiet', () => {
    const [rec] = recordingsOf(recordedTrace(0, 2, 30).entries())
    expect(replayRecording(rec)).toBeNull()
  })

  it('splits a trace into recordings and stops each at its end', () => {
    const entries: TraceEntry[] = [
      { t: 0, kind: 'recording-start', autoSend: 5, engine: 'whisper' },
      { t: 10, kind: 'mic', ms: 100, frames: 10, rms: 0.1 },
      { t: 20, kind: 'recording-end', reason: 'tap or cap' },
      { t: 30, kind: 'mic', ms: 100, frames: 10, rms: 0.1 },
      { t: 40, kind: 'recording-start', autoSend: 0, engine: 'deepgram' },
    ]
    const recs = recordingsOf(entries)
    expect(recs).toHaveLength(2)
    expect(recs[0]).toEqual({ autoSend: 5, mic: [{ ms: 100, rms: 0.1 }], reason: 'tap or cap' })
    expect(recs[1].mic).toEqual([])
  })
})

// Real traces from the glasses (Diagnostics > Copy trace), saved here as
// JSON: each recording that ended by itself must end the same way, at about
// the same time, when replayed. A hardware bug becomes a failing test here.
const FIXTURES = 'tests/fixtures/traces'
const fixtures = existsSync(FIXTURES) ? readdirSync(FIXTURES).filter(f => f.endsWith('.json')) : []

describe.skipIf(fixtures.length === 0)('real glasses traces', () => {
  for (const file of fixtures) {
    it(`${file}: replay ends recordings as the glasses did`, () => {
      const { entries } = JSON.parse(readFileSync(`${FIXTURES}/${file}`, 'utf8'))
      for (const rec of recordingsOf(entries)) {
        if (rec.reason !== 'finished' && rec.reason !== 'no-speech') continue
        expect(replayRecording(rec)?.decision).toBe(rec.reason)
      }
    })
  }
})
