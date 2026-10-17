import type { WakeRequest, WakeResponse } from './wakeWorker'
import { openMic } from './mic'
import { status } from '../platform/bridge'
import { createWakeDetector, pcmToSampleValues } from './wakeWord'

// Always-on "Hey Jarvis" (G2-64): holds the glasses mic while the app is
// open, feeds it to the wake word detector, and calls onWake when it
// fires. app/main.ts decides what a wake does and when listening is
// allowed at all (canWake): never while Jarvis is already busy, so saying
// "Jarvis" inside a question does not start a second one.
//
// The detector runs in a worker (core/wakeWorker.ts) and falls back to the
// main thread on any worker failure, the same safety net as Whisper's (see
// core/whisper.ts) - whether the Even app's WebView allows module workers
// is still unverified on hardware.
//
// It also keeps the last PREROLL_FRAMES of audio, so a recording started
// by the wake word can begin from just before it fired (takePreroll):
// "Hey Jarvis, set a timer" said in one breath keeps "set a timer".

const PREROLL_FRAMES = 15 // 1.5 s of 100 ms mic events
const NEAR_MISS = 0.2
const READY_TIMEOUT_MS = 10_000

type Backend = {
  feed(samples: Float32Array): void
  reset(): void
  stop(): void
}

type Callbacks = {
  onWake: () => void
  onLevel: (maxScore: number) => void
  onLoaded: () => void
  onFailed: (reason: string) => void
}

function modelsUrl(): string {
  return new URL('models/wake/', document.baseURI).href
}

function workerBackend(callbacks: Callbacks, onUnavailable: (reason: string) => void): Backend {
  let worker: Worker
  try {
    // Inline on purpose - Vite only bundles a worker written this way.
    worker = new Worker(new URL('./wakeWorker.ts', import.meta.url), { type: 'module' })
  } catch (e) {
    onUnavailable(`worker could not be created: ${e instanceof Error ? e.message : String(e)}`)
    return { feed() {}, reset() {}, stop() {} }
  }
  let failed = false
  const fail = (reason: string) => {
    if (failed) return
    failed = true
    clearTimeout(readyTimer)
    worker.terminate()
    onUnavailable(reason)
  }
  const readyTimer = setTimeout(() => fail('worker never started'), READY_TIMEOUT_MS)
  worker.addEventListener('message', (event: MessageEvent<WakeResponse>) => {
    const message = event.data
    if (message.kind === 'ready') clearTimeout(readyTimer)
    else if (message.kind === 'loaded') callbacks.onLoaded()
    else if (message.kind === 'loadFailed')
      fail(`models failed to load in worker: ${message.message}`)
    else if (message.kind === 'wake') callbacks.onWake()
    else if (message.kind === 'level') callbacks.onLevel(message.maxScore)
  })
  worker.addEventListener('error', event => {
    event.preventDefault()
    fail(`worker error: ${event.message || 'script failed to load'}`)
  })
  const send = (request: WakeRequest, transfer: Transferable[] = []) => {
    if (!failed) worker.postMessage(request, transfer)
  }
  send({ kind: 'init', modelsUrl: modelsUrl() })
  return {
    // Transferred, not copied: the preroll keeps its own copy of the raw
    // bytes, and these samples are made fresh for the detector alone.
    feed: samples => send({ kind: 'audio', samples }, [samples.buffer]),
    reset: () => send({ kind: 'reset' }),
    stop: () => {
      failed = true
      clearTimeout(readyTimer)
      worker.terminate()
    },
  }
}

// The same detector on the main thread. A few small inferences every 80 ms
// - noticeable but tolerable, and better than no wake word at all.
function mainThreadBackend(callbacks: Callbacks): Backend {
  let stopped = false
  let queue: Float32Array[] = []
  let busy = false
  let detector: ReturnType<typeof createWakeDetector> | null = null
  let makeDetector: (() => ReturnType<typeof createWakeDetector>) | null = null
  let chunks = 0
  let levelMax = 0

  import('./wakeEngine')
    .then(({ loadWebWakeModels }) => loadWebWakeModels(modelsUrl()))
    .then(
      models => {
        makeDetector = () => createWakeDetector(models)
        detector = makeDetector()
        callbacks.onLoaded()
      },
      e =>
        callbacks.onFailed(`models failed to load: ${e instanceof Error ? e.message : String(e)}`),
    )

  async function drain() {
    if (busy) return
    busy = true
    try {
      while (!stopped && detector && queue.length > 0) {
        const result = await detector.process(queue.shift()!)
        levelMax = Math.max(levelMax, result.maxScore)
        chunks += result.scores.length
        if (result.detected) callbacks.onWake()
        if (chunks >= 25) {
          callbacks.onLevel(levelMax)
          chunks = 0
          levelMax = 0
        }
      }
    } finally {
      busy = false
    }
  }

  return {
    feed: samples => {
      if (stopped || !detector) return
      queue.push(samples)
      void drain()
    },
    reset: () => {
      queue = []
      if (makeDetector) detector = makeDetector()
    },
    stop: () => {
      stopped = true
      queue = []
    },
  }
}

let backend: Backend | null = null
let releaseMic: (() => void) | null = null
let preroll: Uint8Array[] = []
let forwarding = false
let description = 'off'
let lastLevel = 0

export type WakeHooks = {
  onWake: () => void
  // Checked on every mic event: false pauses detection (audio is not
  // looked at) until it is true again, when the detector starts fresh.
  canWake: () => boolean
}

export async function startWakeListening({ onWake, canWake }: WakeHooks): Promise<boolean> {
  if (backend) return true
  const callbacks: Callbacks = {
    onWake: () => {
      if (canWake()) onWake()
    },
    onLevel: maxScore => {
      lastLevel = maxScore
      // Close but not enough: on the status line, so a "Hey Jarvis" that
      // did not work shows how far off it was - the number to tune the
      // threshold against on real hardware.
      if (maxScore >= NEAR_MISS && maxScore < 0.5) {
        status(`"Hey Jarvis" near miss, score ${maxScore.toFixed(2)}`)
      }
    },
    onLoaded: () => {
      status(`"Hey Jarvis" ready (${description})`)
    },
    onFailed: reason => {
      description = `unavailable (${reason})`
    },
  }
  description = 'starting (worker)'
  backend = workerBackend(callbacks, reason => {
    console.warn(`Wake word worker unavailable, using the main thread: ${reason}`)
    description = `main thread (${reason})`
    backend = mainThreadBackend(callbacks)
  })
  if (description === 'starting (worker)') description = 'worker'

  const release = await openMic(pcm => {
    preroll.push(pcm)
    if (preroll.length > PREROLL_FRAMES) preroll.shift()
    if (!canWake()) {
      forwarding = false
      return
    }
    if (!forwarding) {
      forwarding = true
      backend?.reset()
    }
    backend?.feed(pcmToSampleValues(pcm))
  })
  if (!release) {
    stopWakeListening()
    description = 'off (mic did not start)'
    return false
  }
  releaseMic = release
  return true
}

export function stopWakeListening() {
  releaseMic?.()
  releaseMic = null
  backend?.stop()
  backend = null
  preroll = []
  forwarding = false
  description = 'off'
}

export function isWakeListening(): boolean {
  return releaseMic !== null
}

// The audio from just before now, oldest first. Taken, not copied: the
// next wake gets its own.
export function takePreroll(): Uint8Array[] {
  const taken = preroll
  preroll = []
  return taken
}

// For the status line: where detection runs and the highest score heard
// in the last couple of seconds (0 to 1, it fires at 0.5).
export function wakeDescription(): string {
  return `${description}, last score ${lastLevel.toFixed(2)}`
}
