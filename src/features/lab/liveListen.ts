import { bridge, status } from '../../platform/bridge'
import { setContent } from '../../platform/page'
import { engineDescription, transcribe } from '../../core/whisper'
import { openMic } from '../../core/mic'
import { SAMPLE_RATE, bytesToSeconds, concat, toFloat32 } from '../../shared/pcm'
import { createFrameTracker } from '../../shared/frameGaps'
import { isSilenceHallucination, stripNonSpeech } from '../../shared/transcript'

// Lab's live transcription probe (G2-60): the measurement every always-on
// Jarvis feature depends on. "Hey Jarvis" and Conversate-style live help
// both need the glasses mic open for a long time and Whisper keeping up
// with speech as it happens. Nobody has measured either on real hardware,
// so this keeps the mic open until stopped, transcribes it continuously in
// fixed chunks through core/whisper.ts (the worker when it works), and
// shows the numbers that decide the design:
//
// - Audio received vs wall clock, and gaps between mic events: does the
//   Bluetooth audio stream stay up, or drop out over time?
// - Whisper seconds per chunk: under CHUNK_SECONDS keeps up, over falls
//   behind for good. Lag is chunk end to text on screen, the delay a
//   wearer would actually feel.
// - UI stall: how late the 1-second redraw timer fires. Small means the
//   main thread stayed free for taps while Whisper ran (the point of
//   G2-59's worker); large means it did not.
// - Battery at start and now, the cost of all of the above.
const CHUNK_SECONDS = 5
const CHUNK_BYTES = CHUNK_SECONDS * SAMPLE_RATE * 2
// Chunks waiting for Whisper beyond this are dropped and counted rather
// than queued forever: if transcription cannot keep up, an ever-growing
// queue would only hide that behind rising memory and lag.
const MAX_BACKLOG = 3
// Mic events arrive every 100 ms; anything this much longer is a dropout.
const GAP_MS = 300
const REDRAW_MS = 1000
const BATTERY_MS = 60_000
const TRANSCRIPT_CHARS = 90

type Chunk = { samples: Float32Array; endedAt: number }

type Session = {
  token: number
  startedAt: number
  frames: ReturnType<typeof createFrameTracker>
  receivedBytes: number
  pendingBytes: Uint8Array[]
  pendingByteCount: number
  backlog: Chunk[]
  transcribing: boolean
  chunksDone: number
  chunksDropped: number
  lastInferMs: number
  maxInferMs: number
  totalInferMs: number
  lastLagMs: number
  maxStallMs: number
  lastRedrawAt: number
  batteryStart: number | null
  batteryNow: number | null
  transcript: string
  error: string | null
}

let session: Session | null = null
let nextToken = 1
let unsubscribe: (() => void) | null = null
let redrawTimer: ReturnType<typeof setInterval> | null = null
let batteryTimer: ReturnType<typeof setInterval> | null = null
let lastScreen = 'Live transcription: starting...'

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1)
}

function clock(ms: number): string {
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function transcriptLine(s: Session): string {
  if (s.error) return `Error: ${s.error}`
  if (!s.transcript) return '(no speech heard yet)'
  return `"${s.transcript.slice(-TRANSCRIPT_CHARS)}"`
}

function render(s: Session): string {
  const now = Date.now()
  const avgInfer = s.chunksDone > 0 ? s.totalInferMs / s.chunksDone : 0
  const battery =
    s.batteryStart === null ? 'battery ?' : `battery ${s.batteryStart} -> ${s.batteryNow ?? '?'}`
  return [
    `Live ${clock(now - s.startedAt)}  ${CHUNK_SECONDS}s chunks  via ${engineDescription()}`,
    `Audio ${bytesToSeconds(s.receivedBytes).toFixed(1)}s of ${seconds(now - s.startedAt)}s  gaps ${s.frames.gapCount()} (max ${seconds(s.frames.longestGapMs())}s)`,
    `Whisper ${seconds(s.lastInferMs)}s (avg ${seconds(avgInfer)}, max ${seconds(s.maxInferMs)})  lag ${seconds(s.lastLagMs)}s`,
    `Done ${s.chunksDone}  waiting ${s.backlog.length}  dropped ${s.chunksDropped}  stall ${seconds(s.maxStallMs)}s`,
    battery,
    transcriptLine(s),
    '(long-press to stop)',
  ].join('\n')
}

function redraw() {
  if (!session) return
  lastScreen = render(session)
  setContent(lastScreen)
}

// One chunk at a time, by this probe's own queue rather than whisper.ts's,
// so lastInferMs is Whisper's time alone and not time spent waiting.
function transcribeNext(s: Session) {
  if (s.transcribing || s.token !== session?.token) return
  const chunk = s.backlog.shift()
  if (!chunk) return
  s.transcribing = true
  const started = performance.now()
  transcribe(chunk.samples)
    .then(text => {
      if (s.token !== session?.token) return
      const inferMs = performance.now() - started
      s.lastInferMs = inferMs
      s.totalInferMs += inferMs
      s.maxInferMs = Math.max(s.maxInferMs, inferMs)
      s.lastLagMs = Date.now() - chunk.endedAt
      s.chunksDone += 1
      const words = stripNonSpeech(text)
      if (words && !isSilenceHallucination(words))
        s.transcript = `${s.transcript} ${words}`.trim().slice(-1000)
    })
    .catch(e => {
      if (s.token === session?.token) s.error = e instanceof Error ? e.message : String(e)
    })
    .finally(() => {
      s.transcribing = false
      transcribeNext(s)
    })
}

function onAudio(s: Session, pcm: Uint8Array) {
  s.frames.onFrame(Date.now())
  s.receivedBytes += pcm.length
  s.pendingBytes.push(pcm)
  s.pendingByteCount += pcm.length
  if (s.pendingByteCount < CHUNK_BYTES) return
  const samples = toFloat32(concat(s.pendingBytes))
  s.pendingBytes = []
  s.pendingByteCount = 0
  if (s.backlog.length >= MAX_BACKLOG) {
    s.chunksDropped += 1
    return
  }
  s.backlog.push({ samples, endedAt: Date.now() })
  transcribeNext(s)
}

function readBattery(s: Session) {
  bridge
    .getDeviceInfo()
    .then(device => {
      const level = device?.status.batteryLevel
      if (level === undefined || s.token !== session?.token) return
      if (s.batteryStart === null) s.batteryStart = level
      s.batteryNow = level
    })
    .catch(() => {})
}

function summary(s: Session): string {
  const avgInfer = s.chunksDone > 0 ? s.totalInferMs / s.chunksDone : 0
  return [
    `Lab live: ${clock(Date.now() - s.startedAt)}`,
    `audio ${bytesToSeconds(s.receivedBytes).toFixed(0)}s`,
    `gaps ${s.frames.gapCount()} max ${seconds(s.frames.longestGapMs())}s`,
    `whisper avg ${seconds(avgInfer)}s max ${seconds(s.maxInferMs)}s per ${CHUNK_SECONDS}s`,
    `done ${s.chunksDone} dropped ${s.chunksDropped}`,
    `stall max ${seconds(s.maxStallMs)}s`,
    `battery ${s.batteryStart ?? '?'} -> ${s.batteryNow ?? '?'}`,
    `via ${engineDescription()}`,
  ].join(', ')
}

export function liveListenContent(): string {
  return lastScreen
}

export function startLiveListen() {
  stopLiveListen(false)
  const now = Date.now()
  const s: Session = {
    token: nextToken++,
    startedAt: now,
    frames: createFrameTracker(GAP_MS),
    receivedBytes: 0,
    pendingBytes: [],
    pendingByteCount: 0,
    backlog: [],
    transcribing: false,
    chunksDone: 0,
    chunksDropped: 0,
    lastInferMs: 0,
    maxInferMs: 0,
    totalInferMs: 0,
    lastLagMs: 0,
    maxStallMs: 0,
    lastRedrawAt: now,
    batteryStart: null,
    batteryNow: null,
    transcript: '',
    error: null,
  }
  session = s
  // Through the shared mic (core/mic.ts), so stopping this probe does not
  // switch the mic off under "Hey Jarvis".
  void openMic(pcm => onAudio(s, pcm)).then(release => {
    status(`Lab live: mic on -> ${release !== null}`)
    if (s.token !== session?.token) {
      release?.()
      return
    }
    if (release) unsubscribe = release
    else s.error = 'mic did not start'
  })
  redrawTimer = setInterval(() => {
    const at = Date.now()
    s.maxStallMs = Math.max(s.maxStallMs, at - s.lastRedrawAt - REDRAW_MS)
    s.lastRedrawAt = at
    redraw()
  }, REDRAW_MS)
  readBattery(s)
  batteryTimer = setInterval(() => readBattery(s), BATTERY_MS)
  redraw()
}

// Safe to call when nothing is running. Always puts the whole result on
// the status line, which the companion page shows. showResult is false
// when Lab itself is closing: that page is on its way out, so there is
// nothing to draw the final numbers on.
export function stopLiveListen(showResult = true) {
  const s = session
  if (!s) return
  session = null
  if (redrawTimer !== null) clearInterval(redrawTimer)
  if (batteryTimer !== null) clearInterval(batteryTimer)
  redrawTimer = null
  batteryTimer = null
  unsubscribe?.()
  unsubscribe = null
  const result = summary(s)
  status(result)
  lastScreen = `Stopped.\n${render(s).split('\n').slice(0, -1).join('\n')}`
  if (showResult) setContent(lastScreen)
}
