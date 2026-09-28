import { AudioInputSource } from '@evenrealities/even_hub_sdk'
import { bridge } from '../../platform/bridge'
import { transcribe } from '../../core/whisper'

// Browser SpeechRecognition looked available (Lab's presence-check probe
// constructed it without throwing) but actually using it fails with
// getUserMedia returning 'not-allowed' on real hardware [HW] - the host
// WebView does not forward the mic permission request, independent of the
// phone's own OS-level app permission. This module captures from the
// glasses mic through the SDK's own audioControl bridge instead, which does
// not go through getUserMedia at all and is already proven working (Lab's
// microphone probe: real streamed PCM frames). See docs/roadmap.md
// decision D1.
export type VoiceResult =
  { kind: 'transcript'; transcript: string } | { kind: 'error'; message: string }

// Driven by the SDK's own LONG_PRESS_EVENT to start (see app/main.ts) and a
// double-press to end - not a release, tried first and dropped: holding down
// the whole time a command was spoken meant releasing ended the recording
// before an interim caption ever had a chance to appear. MAX_RECORD_MS only
// exists as a safety net for a wearer who never double-presses at all - the
// normal end of a recording is always the deliberate double-press, not this
// timer.
const MAX_RECORD_MS = 15_000

// How often to re-transcribe everything captured so far and report it as an
// interim caption while still recording. Whisper has no true streaming mode
// here - each tick re-runs on the whole buffer, which is why this is a
// second or two apart rather than continuous: much tighter and a long
// recording would mean overlapping transcribe calls competing for the same
// CPU. Short enough that even a quick command ("timer 5 minutes", spoken in
// under 2 seconds) has a real chance of showing at least one interim caption
// before the wearer double-presses.
const INTERIM_INTERVAL_MS = 1500

let chunks: Uint8Array[] = []
let unsubscribe: (() => void) | null = null
let interimTimer: ReturnType<typeof setInterval> | null = null
let safetyTimer: ReturnType<typeof setTimeout> | null = null
let onInterim: ((text: string) => void) | null = null
let interimInFlight = false

// Signed 16-bit little-endian PCM (see docs/platform.md, Device APIs) ->
// Float32 samples in [-1, 1], the shape every Transformers.js ASR pipeline
// expects.
function toFloat32(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const samples = new Float32Array(Math.floor(bytes.length / 2))
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * 2, true) / 32768
  }
  return samples
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

// Skipped, not queued, when a previous tick is still running - a hold long
// enough to fall behind should catch up by skipping stale ticks, not by
// piling up transcribe() calls that all eventually land out of order.
async function transcribeSoFar() {
  if (interimInFlight || chunks.length === 0) return
  interimInFlight = true
  try {
    const audio = toFloat32(concat(chunks))
    const text = await transcribe(audio)
    if (text) onInterim?.(text)
  } catch {
    // Interim failures are silent - the final transcribe in stop() is the
    // one that actually matters, and surfacing every mid-hold hiccup on
    // screen would be noise the wearer cannot act on anyway.
  } finally {
    interimInFlight = false
  }
}

// Starts capturing from the glasses mic and begins reporting interim
// transcriptions to onCaptionUpdate every INTERIM_INTERVAL_MS. Resolves once
// capture has actually started (or failed to). onSafetyTimeout fires once,
// MAX_RECORD_MS after starting, only if stop() has not already been called
// by then - a wearer who never double-presses should still get the
// recording ended for them. The caller's onSafetyTimeout is expected to
// call stop() itself, exactly as it would on a real double-press.
export async function start(
  onCaptionUpdate: (text: string) => void,
  onSafetyTimeout: () => void,
): Promise<boolean> {
  chunks = []
  onInterim = onCaptionUpdate
  unsubscribe = bridge.onEvenHubEvent(event => {
    const audio = event.audioEvent
    if (!audio || audio.source !== AudioInputSource.Glasses) return
    chunks.push(audio.audioPcm)
  })
  const ok = await bridge.audioControl(true, AudioInputSource.Glasses)
  if (!ok) {
    unsubscribe?.()
    unsubscribe = null
    onInterim = null
    return false
  }
  interimTimer = setInterval(transcribeSoFar, INTERIM_INTERVAL_MS)
  safetyTimer = setTimeout(onSafetyTimeout, MAX_RECORD_MS)
  return true
}

function teardownCapture() {
  if (interimTimer !== null) {
    clearInterval(interimTimer)
    interimTimer = null
  }
  if (safetyTimer !== null) {
    clearTimeout(safetyTimer)
    safetyTimer = null
  }
  unsubscribe?.()
  unsubscribe = null
  onInterim = null
  bridge.audioControl(false)
}

// Ends capture and runs one final transcription over everything recorded,
// for the best accuracy the model can give rather than whatever an interim
// tick happened to catch mid-word.
export async function stop(): Promise<VoiceResult> {
  teardownCapture()
  if (chunks.length === 0) return { kind: 'error', message: 'no audio captured' }
  try {
    const audio = toFloat32(concat(chunks))
    const transcript = await transcribe(audio)
    if (!transcript) return { kind: 'error', message: 'heard nothing' }
    return { kind: 'transcript', transcript }
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) }
  }
}

// Abandons a session outright with no final transcription: the tool closed
// or the app suspended mid-recording, so there is no page left to show a
// result on even if one were computed.
export function cancel() {
  teardownCapture()
  chunks = []
}
