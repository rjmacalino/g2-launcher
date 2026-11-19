// A hardware trace (G2-171): what the glasses actually sent, kept in a ring
// buffer so a bug seen on the glasses can be copied from Diagnostics and
// replayed as a test on the PC (replayRecording below, tests/trace.test.ts),
// instead of being guessed at. Pure, no I/O.
//
// Private by design: events keep only their type and container, never text
// or list item names (chat titles); the mic keeps only loudness per ~100 ms,
// never audio.

import { createTurnDetector } from './endOfTurn'
import type { EndpointDecision } from './endpoint'

export type TraceEntry =
  // Milliseconds since the trace started.
  | {
      t: number
      kind: 'event'
      source: 'sys' | 'text' | 'list'
      type: number | null
      container?: string
      index?: number
    }
  // ~100 ms of mic audio: how long it was, how many frames, the loudest RMS.
  | { t: number; kind: 'mic'; ms: number; frames: number; rms: number }
  | { t: number; kind: 'recording-start'; autoSend: number; engine: string }
  | { t: number; kind: 'recording-end'; reason: string }
  | { t: number; kind: 'transcript'; chars: number }

// Without the time, as callers add it.
type NewEntry = TraceEntry extends infer E ? (E extends TraceEntry ? Omit<E, 't'> : never) : never

export type Trace = {
  add(entry: NewEntry): void
  // A mic frame: folded into ~100 ms entries so the buffer covers minutes.
  mic(ms: number, rms: number): void
  entries(): TraceEntry[]
  toJson(): string
}

const MIC_WINDOW_MS = 100

export function createTrace(maxEntries = 4000, now: () => number = Date.now): Trace {
  const started = now()
  const entries: TraceEntry[] = []
  let window: { t: number; ms: number; frames: number; rms: number } | null = null

  function push(entry: TraceEntry): void {
    entries.push(entry)
    if (entries.length > maxEntries) entries.shift()
  }

  function flushMic(): void {
    if (!window) return
    push({ kind: 'mic', ...window, rms: Math.round(window.rms * 10000) / 10000 })
    window = null
  }

  return {
    add(entry) {
      flushMic()
      push({ ...entry, t: now() - started } as TraceEntry)
    },
    mic(ms, rms) {
      if (!window) window = { t: now() - started, ms: 0, frames: 0, rms: 0 }
      window.ms += ms
      window.frames += 1
      window.rms = Math.max(window.rms, rms)
      if (window.ms >= MIC_WINDOW_MS) flushMic()
    },
    entries() {
      flushMic()
      return [...entries]
    },
    toJson() {
      return JSON.stringify({ version: 1, entries: this.entries() })
    },
  }
}

// The one trace the app records into.
export const trace = createTrace()

// One recording out of a trace: its settings and its mic, in order.
export type Recording = {
  autoSend: number
  mic: { ms: number; rms: number }[]
  // How it ended on the glasses.
  reason: string | null
}

// Replays a recording through the same end-of-turn detector the glasses use,
// set up as voiceCapture.ts sets it up: when would it have ended by itself,
// and why? null: it would not have (only a tap or the 10-minute cap).
// The mic arrives in ~100 ms windows rather than single frames, so the
// moment speech is first detected can differ by a window; quiet time is
// exact.
export function replayRecording(
  rec: Recording,
): { decision: Exclude<EndpointDecision, 'listening'>; atMs: number } | null {
  const pauseMs = rec.autoSend > 0 ? rec.autoSend * 1000 : Infinity
  const turn = createTurnDetector({ completePauseMs: pauseMs, incompletePauseMs: pauseMs })
  let at = 0
  for (const window of rec.mic) {
    at += window.ms
    const decision = turn.push(window.rms, null, window.ms)
    if (decision !== 'listening') return { decision, atMs: at }
  }
  return null
}

export function recordingsOf(entries: readonly TraceEntry[]): Recording[] {
  const out: Recording[] = []
  let current: Recording | null = null
  for (const e of entries) {
    if (e.kind === 'recording-start') {
      current = { autoSend: e.autoSend, mic: [], reason: null }
      out.push(current)
    } else if (e.kind === 'mic' && current && current.reason === null) {
      current.mic.push({ ms: e.ms, rms: e.rms })
    } else if (e.kind === 'recording-end' && current) {
      current.reason = e.reason
    }
  }
  return out
}
