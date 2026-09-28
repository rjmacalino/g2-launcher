import { AudioInputSource } from '@evenrealities/even_hub_sdk'
import { bridge } from '../../platform/bridge'
import { transcribe } from './whisper'

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

// How long to record if the wearer never long-presses to end it early (see
// the tool's onLongPress). Long enough for a real command ("Jarvis, set a
// timer for twenty five minutes") without leaving the mic running
// indefinitely if nothing happens.
const MAX_RECORD_MS = 8000

// PCM chunks accumulate here while recording, cleared at the start of each
// recordAndTranscribe() call so a stale chunk from a previous session can
// never leak into a new one.
let chunks: Uint8Array[] = []
let unsubscribe: (() => void) | null = null
let stopEarly: (() => void) | null = null

function startCapture(): Promise<boolean> {
  chunks = []
  unsubscribe = bridge.onEvenHubEvent(event => {
    const audio = event.audioEvent
    if (!audio || audio.source !== AudioInputSource.Glasses) return
    chunks.push(audio.audioPcm)
  })
  return bridge.audioControl(true, AudioInputSource.Glasses)
}

function stopCapture() {
  unsubscribe?.()
  unsubscribe = null
  bridge.audioControl(false)
}

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

// Records from the glasses mic until either the wearer long-presses to end
// it early or MAX_RECORD_MS passes, then runs the result through Whisper.
// One call, one result - matches the tool's own push-to-talk shape (opening
// the page IS the push).
export async function recordAndTranscribe(): Promise<VoiceResult> {
  const ok = await startCapture()
  if (!ok) return { kind: 'error', message: 'could not start the glasses microphone' }

  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, MAX_RECORD_MS)
    stopEarly = () => {
      clearTimeout(timer)
      resolve()
    }
  })
  stopEarly = null
  stopCapture()

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

// Ends recording early - the wearer long-pressed to say "that's my command."
export function stopNow() {
  stopEarly?.()
}

// Abandons a session outright: the tool closed or the app suspended
// mid-recording. Same early-stop plus a capture teardown, since there is no
// result worth transcribing once the page that would show it is gone.
export function cancel() {
  stopEarly?.()
  stopCapture()
}
