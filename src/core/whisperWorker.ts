// Runs core/whisperEngine.ts inside a Web Worker: a separate JS thread
// with no access to the page, the DOM or the SDK bridge, talking to the
// main thread only through postMessage. Whisper inference is CPU-bound WASM
// that takes seconds; on the main thread it blocks every tap, timer and
// screen update until it finishes (the "Transcribing" counter sat at 0s on
// real hardware [HW], see features/chat/tool.ts). Here it blocks only this
// worker's thread, which nothing else needs. That is what makes running it
// repeatedly during a recording (live captions) safe to try at all - see
// the G2-53 history in core/voiceCapture.ts.
//
// Started only by core/whisper.ts, never imported. The protocol types live
// here because this file is the one that has to honour them; whisper.ts
// imports them as types only, which pulls in no worker code.
import { getPipeline, transcribe } from './whisperEngine'

export type WorkerRequest =
  { kind: 'preload' } | { kind: 'transcribe'; id: number; audio: Float32Array }

// 'ready' is sent once, as soon as this script runs, so the main thread can
// tell "worker started" apart from "worker silently never ran". 'loadFailed'
// means the model could not be set up in here at all, which the main
// thread treats as "workers do not work in this WebView" and falls back;
// 'failed' is an ordinary error for one recording, same as before workers.
export type WorkerResponse =
  | { kind: 'ready' }
  // The model is set up and can transcribe (G2-82).
  | { kind: 'loaded' }
  | { kind: 'loadFailed'; message: string }
  | { kind: 'done'; id: number; text: string }
  | { kind: 'failed'; id: number; message: string }

// tsconfig only loads the DOM types, where `self` is a Window. A worker's
// global is a different object; this is the slice of it actually used.
type WorkerScope = {
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void
  postMessage(message: WorkerResponse): void
}
const scope = self as unknown as WorkerScope

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function reportLoadFailure(e: unknown) {
  scope.postMessage({ kind: 'loadFailed', message: errorText(e) })
}

let loadedSent = false

async function loadModel(): Promise<void> {
  await getPipeline()
  if (!loadedSent) {
    loadedSent = true
    scope.postMessage({ kind: 'loaded' })
  }
}

async function handleTranscribe(id: number, audio: Float32Array) {
  try {
    await loadModel()
  } catch (e) {
    reportLoadFailure(e)
    return
  }
  try {
    scope.postMessage({ kind: 'done', id, text: await transcribe(audio) })
  } catch (e) {
    scope.postMessage({ kind: 'failed', id, message: errorText(e) })
  }
}

scope.addEventListener('message', event => {
  const request = event.data
  if (request.kind === 'preload') {
    loadModel().catch(reportLoadFailure)
    return
  }
  void handleTranscribe(request.id, request.audio)
})

scope.postMessage({ kind: 'ready' })
