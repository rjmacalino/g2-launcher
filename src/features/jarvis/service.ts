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
// double-press to end. MAX_RECORD_MS only exists as a safety net for a
// wearer who never double-presses at all - the normal end of a recording is
// always the deliberate double-press, not this timer.
const MAX_RECORD_MS = 15_000

// No interim, incrementally-transcribed captions here on purpose - tried in
// G2-51/G2-52 and reverted [HW]: real-hardware testing found neither the
// captions nor the double-press-to-stop worked reliably. The likely cause,
// not fully confirmed but consistent with everything observed: Whisper
// inference is CPU-bound WASM running on the main JS thread, and re-running
// it on the WHOLE growing buffer every 1.5s (no true streaming mode exists
// here) means later ticks take progressively longer. On hardware slower
// than the dev machine this was built against (where even 1s of audio took
// ~2s to transcribe), that can block the thread long enough to stall event
// processing itself - which would explain a double-press never registering,
// not just captions never appearing. A single clean transcription at the
// end, with nothing running while the mic is open, is the version that was
// actually confirmed working on real hardware (G2-49). True live captions
// would need inference moved off the main thread (a Web Worker) to be safe
// to run repeatedly during a recording - a real, separate piece of work,
// not a tweak to this one.
let chunks: Uint8Array[] = []
let unsubscribe: (() => void) | null = null
let safetyTimer: ReturnType<typeof setTimeout> | null = null

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

// Starts capturing from the glasses mic. Resolves once capture has actually
// started (or failed to). onSafetyTimeout fires once, MAX_RECORD_MS after
// starting, only if stop() has not already been called by then - a wearer
// who never double-presses should still get the recording ended for them.
// The caller's onSafetyTimeout is expected to call stop() itself, exactly
// as it would on a real double-press.
export async function start(onSafetyTimeout: () => void): Promise<boolean> {
  chunks = []
  unsubscribe = bridge.onEvenHubEvent(event => {
    const audio = event.audioEvent
    if (!audio || audio.source !== AudioInputSource.Glasses) return
    chunks.push(audio.audioPcm)
  })
  const ok = await bridge.audioControl(true, AudioInputSource.Glasses)
  if (!ok) {
    unsubscribe?.()
    unsubscribe = null
    return false
  }
  safetyTimer = setTimeout(onSafetyTimeout, MAX_RECORD_MS)
  return true
}

function teardownCapture() {
  if (safetyTimer !== null) {
    clearTimeout(safetyTimer)
    safetyTimer = null
  }
  unsubscribe?.()
  unsubscribe = null
  bridge.audioControl(false)
}

// Ends capture and runs one transcription over everything recorded.
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
