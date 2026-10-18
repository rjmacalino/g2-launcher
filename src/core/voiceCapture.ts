import { isOnWorker, transcribe } from './whisper'
import { pickCut } from '../shared/pieces'
import { openMic } from './mic'
import { SAMPLE_RATE, concat, toFloat32 } from '../shared/pcm'
import { isSilenceHallucination, stripNonSpeech, stripWakePhrase } from '../shared/transcript'
import { createEndpointer, endsInSpeech, rmsLevel, type EndpointDecision } from '../shared/endpoint'

// Browser SpeechRecognition looked available (Lab's presence-check probe
// constructed it without throwing) but actually using it fails with
// getUserMedia returning 'not-allowed' on real hardware [HW] - the host
// WebView does not forward the mic permission request, independent of the
// phone's own OS-level app permission. This module captures from the
// glasses mic through the SDK's own audioControl bridge instead, which does
// not go through getUserMedia at all and is already proven working (Lab's
// microphone probe: real streamed PCM frames). See docs/roadmap.md
// decision D1.
//
// Lives in core/, not features/jarvis, because more than one feature needs
// it now (Jarvis's one-shot commands/questions, and Chat's ongoing
// conversation) - same reasoning as core/whisper.ts, which this already
// depended on. Each caller (jarvis/tool.ts, chat/tool.ts) owns its own
// long-press-to-start / double-press-to-end gesture wiring and session
// bookkeeping; this file only owns capturing PCM and turning it into text.
// peak is the loudest sample in the recording (0 to 1) - reported on the
// status line so real-hardware use shows what speech actually measures,
// before any "too quiet to be speech" threshold gets picked. audioSeconds
// and transcribeMs are reported the same way: how long Whisper takes per
// second of audio on the real phone decides whether live transcription
// (Conversate-style) can keep up at all, and nothing else measures it.
export type VoiceResult =
  | {
      kind: 'transcript'
      transcript: string
      peak: number
      audioSeconds: number
      transcribeMs: number
      // The room's quiet level and the loudest moment as the end-of-speech
      // detector saw them, for tuning it on hardware. Only for recordings
      // that end on silence.
      levels: { floor: number; loudest: number } | null
    }
  | { kind: 'error'; message: string }

// How a recording started by "Hey Jarvis" differs from a long-press one
// (G2-64). preroll: the audio from just before the wake word fired, so
// words said straight after it are kept. onEndpoint: called once when the
// wearer has stopped talking (or never started), so the caller can end the
// recording without a tap. stripWake: remove "Hey Jarvis" from the start
// of the transcript, since the preroll contains it.
export type CaptureOptions = {
  preroll?: readonly Uint8Array[]
  onEndpoint?: (decision: Exclude<EndpointDecision, 'listening'>) => void
  stripWake?: boolean
}

// Driven by the caller's own long-press-to-start / double-press-to-end
// wiring (see app/main.ts for how each tool claims that gesture while it is
// the active screen). MAX_RECORD_MS only exists as a safety net for a
// wearer who never ends the recording at all - the normal end is always the
// deliberate gesture, not this timer. Three minutes per direct request, so
// a long question is never cut off mid-sentence; transcribing more than 30
// seconds depends on the chunked transcription in core/whisper.ts.
const MAX_RECORD_MS = 180_000

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
// to run repeatedly during a recording. G2-59 built that worker (see
// core/whisper.ts), but it is not yet confirmed on real hardware, and it
// still falls back to the main thread where workers fail - so this module
// keeps the one-transcription-at-the-end shape until both are known.
let chunks: Uint8Array[] = []

// Transcribing while the wearer talks (G2-82). The note above still holds
// for the main thread, so this only runs when Whisper is in the worker -
// and unlike G2-51, each piece of audio is transcribed exactly once, so
// the work never grows with the recording. Stopping then leaves only the
// last piece to wait for. Pieces are about 6 to 10 seconds, cut at the
// quietest moment so a word is rarely split (shared/pieces.ts).
const PIECE_RULE = { minSamples: 10 * SAMPLE_RATE, searchFromSamples: 6 * SAMPLE_RATE }
let levels: number[] = []
let cutFrom = 0
let pieces: Promise<string>[] = []
let pieceBusy = false

function piecePeak(parts: readonly Uint8Array[]): number {
  return peakLevel(toFloat32(concat(parts)))
}

// Starts transcribing the next piece if one is ready and none is running.
function maybeTranscribePiece() {
  if (pieceBusy || !isOnWorker()) return
  const cut = pickCut(
    chunks.map(c => c.length / 2),
    levels,
    cutFrom,
    PIECE_RULE,
  )
  if (cut === null) return
  const parts = chunks.slice(cutFrom, cut + 1)
  cutFrom = cut + 1
  // A silent piece would come back as an invented sentence.
  if (piecePeak(parts) < SILENCE_PEAK) return
  pieceBusy = true
  pieces.push(
    transcribe(toFloat32(concat(parts)))
      .then(text => {
        const heard = stripNonSpeech(text)
        return isSilenceHallucination(heard) ? '' : heard
      })
      .catch(() => '')
      .finally(() => {
        pieceBusy = false
      }),
  )
}
let releaseMic: (() => void) | null = null
let safetyTimer: ReturnType<typeof setTimeout> | null = null
let options: CaptureOptions = {}
let endpointer: ReturnType<typeof createEndpointer> | null = null
// Bumped by every start and teardown, so audio from a recording that has
// already ended never reaches the next one's endpointer.
let captureToken = 0
// How the end-of-speech detector ended the last recording, if it did.
let endpointDecision: EndpointDecision | null = null

function levelsOf(parts: readonly Uint8Array[]): number[] {
  return parts.map(part => rmsLevel(toFloat32(part)))
}

// Starts capturing from the glasses mic. Resolves once capture has actually
// started (or failed to). onSafetyTimeout fires once, MAX_RECORD_MS after
// starting, only if stop() has not already been called by then - a wearer
// who never double-presses should still get the recording ended for them.
// The caller's onSafetyTimeout is expected to call stop() itself, exactly
// as it would on a real double-press.
export async function start(
  onSafetyTimeout: () => void,
  captureOptions: CaptureOptions = {},
): Promise<boolean> {
  const myCapture = ++captureToken
  options = captureOptions
  chunks = [...(captureOptions.preroll ?? [])]
  levels = levelsOf(chunks)
  cutFrom = 0
  pieces = []
  pieceBusy = false
  const onEndpoint = captureOptions.onEndpoint
  const prerollLevels = levelsOf(captureOptions.preroll ?? [])
  endpointer = onEndpoint
    ? createEndpointer({
        initialFloor: prerollLevels.length > 0 ? Math.min(...prerollLevels) : undefined,
        alreadySpeaking: endsInSpeech(prerollLevels),
      })
    : null
  let endpointReported = false
  endpointDecision = null
  const release = await openMic(pcm => {
    if (myCapture !== captureToken) return
    chunks.push(pcm)
    levels.push(rmsLevel(toFloat32(pcm)))
    maybeTranscribePiece()
    if (!endpointer || !onEndpoint || endpointReported) return
    const decision = endpointer.push(rmsLevel(toFloat32(pcm)))
    if (decision === 'listening') return
    endpointReported = true
    endpointDecision = decision
    onEndpoint(decision)
  })
  if (!release) return false
  if (myCapture !== captureToken) {
    release()
    return false
  }
  releaseMic = release
  safetyTimer = setTimeout(onSafetyTimeout, MAX_RECORD_MS)
  return true
}

function teardownCapture() {
  captureToken++
  if (safetyTimer !== null) {
    clearTimeout(safetyTimer)
    safetyTimer = null
  }
  releaseMic?.()
  releaseMic = null
}

// Below this, the recording is digital silence - the microphone delivered
// frames but no sound at all, not a quiet room (a real microphone's own
// noise floor sits well above it). Whisper does not return nothing for
// silence: it invents a plausible sentence ["So how should it find us?" in
// the simulator, which has no real microphone], which then went to Gemini
// as a question and became a saved conversation's title. Skipping the
// transcription also saves the wait for it.
const SILENCE_PEAK = 0.001

function peakLevel(samples: Float32Array): number {
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const level = Math.abs(samples[i])
    if (level > peak) peak = level
  }
  return peak
}

// Ends capture and runs one transcription over everything recorded.
export async function stop(): Promise<VoiceResult> {
  teardownCapture()
  if (chunks.length === 0) return { kind: 'error', message: 'no audio captured' }
  try {
    const audio = toFloat32(concat(chunks))
    const peak = peakLevel(audio)
    if (peak < SILENCE_PEAK) {
      return { kind: 'error', message: 'no sound picked up' }
    }
    // The wait the wearer feels: pieces still running, plus the rest.
    const transcribeStart = performance.now()
    const tail = toFloat32(concat(chunks.slice(cutFrom)))
    const texts = await Promise.all([
      ...pieces,
      tail.length > 0 ? transcribe(tail).then(stripNonSpeech) : Promise.resolve(''),
    ])
    const heard = texts.filter(Boolean).join(' ').trim()
    const transcribeMs = Math.round(performance.now() - transcribeStart)
    if (!heard || isSilenceHallucination(heard)) {
      return { kind: 'error', message: `heard nothing - audio level ${peak.toFixed(3)}` }
    }
    const transcript = options.stripWake ? stripWakePhrase(heard) : heard
    if (!transcript) return { kind: 'error', message: 'heard only "Hey Jarvis"' }
    // No speech after "Hey Jarvis", and Whisper did not hear "Hey Jarvis"
    // in the preroll either: the audio was too faint to trust, and what came
    // back is the kind of thing Whisper invents from near-silence ["Great
    // job." from six quiet seconds in the simulator]. With the wake phrase
    // heard, the audio was clear enough that the rest is real.
    if (options.stripWake && endpointDecision === 'no-speech' && transcript === heard) {
      return { kind: 'error', message: `no speech after "Hey Jarvis" (noise read as "${heard}")` }
    }
    return {
      kind: 'transcript',
      transcript,
      peak,
      audioSeconds: audio.length / SAMPLE_RATE,
      transcribeMs,
      levels: endpointer ? { floor: endpointer.floor(), loudest: endpointer.loudest() } : null,
    }
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
  pieces = []
}
