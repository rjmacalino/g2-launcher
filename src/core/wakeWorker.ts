// Runs the "Hey Jarvis" detector (core/wakeWord.ts) in a Web Worker, the
// same arrangement as core/whisperWorker.ts: the detector runs every 80 ms
// for as long as the app is open, and none of that should compete with
// taps and screen updates on the main thread. Started only by
// core/wakeListener.ts, which falls back to the main thread if this fails.
import { createWakeDetector } from './wakeWord'
import { loadWebWakeModels } from './wakeEngine'

export type WakeRequest =
  | { kind: 'init'; modelsUrl: string }
  // Raw 16-bit sample values (core/wakeWord.ts's pcmToSampleValues).
  | { kind: 'audio'; samples: Float32Array }
  // Forget everything heard so far: audio stopped flowing for a while
  // (Jarvis was busy, the app was away), and stale audio glued to fresh
  // audio is exactly the kind of input that produces a false wake.
  | { kind: 'reset' }

export type WakeResponse =
  | { kind: 'ready' }
  | { kind: 'loaded' }
  | { kind: 'loadFailed'; message: string }
  | { kind: 'wake'; score: number }
  // The highest score in the last couple of seconds, for the status line.
  | { kind: 'level'; maxScore: number }

type WorkerScope = {
  addEventListener(type: 'message', listener: (event: MessageEvent<WakeRequest>) => void): void
  postMessage(message: WakeResponse): void
}
const scope = self as unknown as WorkerScope

const LEVEL_EVERY_CHUNKS = 25

let detector: ReturnType<typeof createWakeDetector> | null = null
let makeDetector: (() => ReturnType<typeof createWakeDetector>) | null = null
let queue: Float32Array[] = []
let busy = false
let chunksSinceLevel = 0
let levelMax = 0

async function drain() {
  if (busy || !detector) return
  busy = true
  try {
    while (queue.length > 0 && detector) {
      const samples = queue.shift()!
      const result = await detector.process(samples)
      levelMax = Math.max(levelMax, result.maxScore)
      chunksSinceLevel += result.scores.length
      if (result.detected) scope.postMessage({ kind: 'wake', score: result.maxScore })
      if (chunksSinceLevel >= LEVEL_EVERY_CHUNKS) {
        scope.postMessage({ kind: 'level', maxScore: levelMax })
        chunksSinceLevel = 0
        levelMax = 0
      }
    }
  } finally {
    busy = false
  }
}

scope.addEventListener('message', event => {
  const request = event.data
  if (request.kind === 'init') {
    loadWebWakeModels(request.modelsUrl).then(
      models => {
        makeDetector = () => createWakeDetector(models)
        detector = makeDetector()
        scope.postMessage({ kind: 'loaded' })
        void drain()
      },
      e =>
        scope.postMessage({
          kind: 'loadFailed',
          message: e instanceof Error ? e.message : String(e),
        }),
    )
    return
  }
  if (request.kind === 'reset') {
    queue = []
    if (makeDetector) detector = makeDetector()
    return
  }
  // Audio that arrives before the models load is dropped, not queued: a
  // wake word said before Jarvis could hear it is not one to act on late.
  if (!detector) return
  queue.push(request.samples)
  void drain()
})

scope.postMessage({ kind: 'ready' })
