// The front door to on-device speech-to-text. Callers (core/voiceCapture.ts,
// app/main.ts's startup preload) use transcribe() and preload() exactly as
// before; what changed is where the work runs. This file tries to run the
// engine (core/whisperEngine.ts) in a Web Worker (core/whisperWorker.ts)
// so inference stops blocking taps and screen updates, and falls back to
// running it right here on the main thread - the shape confirmed working
// on real hardware since G2-49 - whenever the worker path fails.
//
// The fallback is not optional polish: whether the Even app's WebView
// allows module workers at all, and whether Transformers.js can load its
// model inside one there, are both unverified (nothing in the Even Hub
// docs says either way). A worker that cannot start must never cost the
// wearer their voice commands, so every way the worker path can fail
// lands back on the main thread, and the one recording that hit it is
// retried there rather than lost.
import type { WorkerRequest, WorkerResponse } from './whisperWorker'
import { status } from '../platform/bridge'
import * as mainThread from './whisperEngine'

// The worker script itself is small (the model is loaded later, on first
// use), so a worker that has not said 'ready' by now is never going to.
// Without this, a WebView that accepts `new Worker` but never runs it
// would leave every recording stuck on "Transcribing" for good.
const READY_TIMEOUT_MS = 10_000

// A worker that started but never answers would leave a recording stuck
// on "transcribing" for good - seen on the glasses (G2-82), where the
// worker path had never been confirmed. Each request gets a deadline;
// missing it means the worker is not working here, so it is stopped and
// the recording is redone on the main thread. Longer while the model is
// still loading, since the first use downloads it.
const ANSWER_MS_LOADING = 90_000
const ANSWER_MS_BASE = 15_000
const ANSWER_MS_PER_AUDIO_SECOND = 2_000
let modelLoaded = false

type Pending = {
  timer: ReturnType<typeof setTimeout>
  audio: Float32Array
  resolve: (text: string) => void
  reject: (error: Error) => void
}

let worker: Worker | null = null
let readyTimer: ReturnType<typeof setTimeout> | null = null
// Set once, the first time the worker path fails, and never cleared: one
// failure is taken to mean workers do not work in this WebView, so later
// recordings go straight to the main thread instead of each one waiting
// out the same failure again. The next app start tries the worker afresh.
let fallbackReason: string | null = null
const pending = new Map<number, Pending>()
let nextId = 1

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function fallBackToMainThread(reason: string) {
  if (fallbackReason !== null) return
  fallbackReason = reason
  console.warn(`Whisper worker unavailable, using the main thread: ${reason}`)
  status(`Whisper: switched to the main thread (${reason})`)
  if (readyTimer !== null) clearTimeout(readyTimer)
  readyTimer = null
  worker?.terminate()
  worker = null
  for (const [id, request] of pending) {
    pending.delete(id)
    clearTimeout(request.timer)
    mainThread.transcribe(request.audio).then(request.resolve, request.reject)
  }
}

function handleMessage(message: WorkerResponse) {
  if (message.kind === 'ready') {
    if (readyTimer !== null) clearTimeout(readyTimer)
    readyTimer = null
    return
  }
  if (message.kind === 'loaded') {
    modelLoaded = true
    status('Whisper model ready (worker)')
    return
  }
  if (message.kind === 'loadFailed') {
    fallBackToMainThread(`model load failed in worker: ${message.message}`)
    return
  }
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  clearTimeout(request.timer)
  if (message.kind === 'done') request.resolve(message.text)
  else request.reject(new Error(message.message))
}

// Started lazily, on the first preload() or transcribe(), and kept for the
// app's lifetime - the same "load once" reasoning as the pipeline itself.
function getWorker(): Worker | null {
  if (fallbackReason !== null) return null
  if (worker) return worker
  try {
    // Written exactly this way, inline, on purpose: Vite only recognises
    // `new Worker(new URL('./file', import.meta.url))` as a worker and
    // bundles the file as one. Moving the URL into a variable breaks that.
    worker = new Worker(new URL('./whisperWorker.ts', import.meta.url), { type: 'module' })
  } catch (e) {
    fallBackToMainThread(`worker could not be created: ${errorText(e)}`)
    return null
  }
  readyTimer = setTimeout(() => fallBackToMainThread('worker never started'), READY_TIMEOUT_MS)
  worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) =>
    handleMessage(event.data),
  )
  worker.addEventListener('error', event => {
    // Handled here, so it must not also reach the page's global error
    // handler (platform/bridge.ts), which would put a misleading "Error:"
    // on the status line for something that has already been recovered.
    event.preventDefault()
    fallBackToMainThread(`worker error: ${event.message || 'script failed to load'}`)
  })
  worker.addEventListener('messageerror', () => {
    fallBackToMainThread('worker could not read a message')
  })
  return worker
}

function send(target: Worker, request: WorkerRequest) {
  target.postMessage(request)
}

// Called once at startup (see app/main.ts) so the model is hopefully
// already loaded, or at least in flight, by the time the wearer first
// speaks. Never throws and never needs awaiting - a failure surfaces later
// through transcribe(), the call that actually reports it on screen.
export function preload() {
  const target = getWorker()
  if (target) send(target, { kind: 'preload' })
  else mainThread.preload()
}

export function transcribe(audio: Float32Array): Promise<string> {
  const target = getWorker()
  if (!target) return mainThread.transcribe(audio)
  return new Promise((resolve, reject) => {
    const id = nextId++
    const seconds = audio.length / 16_000
    const deadline = modelLoaded
      ? ANSWER_MS_BASE + seconds * ANSWER_MS_PER_AUDIO_SECOND
      : ANSWER_MS_LOADING
    const timer = setTimeout(
      () =>
        fallBackToMainThread(
          `no answer in ${Math.round(deadline / 1000)}s (${modelLoaded ? 'model loaded' : 'model still loading'})`,
        ),
      deadline,
    )
    pending.set(id, { timer, audio, resolve, reject })
    // Copied to the worker, not transferred: transferring would empty this
    // side's copy of the samples, and the fallback above needs them to
    // retry the recording on the main thread if the worker fails mid-way.
    send(target, { kind: 'transcribe', id, audio })
  })
}

// True only when transcription runs in the worker: work done while the
// mic is open (G2-82) is only safe off the main thread (voiceCapture.ts).
export function isOnWorker(): boolean {
  return fallbackReason === null && worker !== null
}

// Which path transcription is taking, for the status line: on real
// hardware this is the only way to find out whether workers work there.
export function engineDescription(): string {
  if (fallbackReason !== null) return `main thread (${fallbackReason})`
  return worker ? 'worker' : 'not started'
}
