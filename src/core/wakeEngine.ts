// The same entry point Transformers.js imports (check its dist if that
// changes): any other one pulls a second ~28 MB WASM runtime into the app
// package next to the one Whisper already ships.
import * as ort from 'onnxruntime-web/webgpu'
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url'
import type { OnnxRunner, WakeModels } from './wakeWord'

// Where the runtime's WASM file is, as Vite serves it (dev) or emitted it
// (build). Left to find it itself, the runtime looked next to its own
// script and, in the dev server, got the HTML page back instead - "expected
// magic word 00 61 73 6d, found 3c 21 64 6f", the bytes of "<!do". The
// build already ships this exact file for Whisper, so it is not added twice.
ort.env.wasm.wasmPaths = { wasm: wasmUrl }

// Loads the wake word models (public/models/wake) with onnxruntime-web,
// the browser build of the runtime that tests and the PC benchmark use
// through onnxruntime-node. Used inside core/wakeWorker.ts, or on the
// main thread when workers are not available (core/wakeListener.ts).
//
// One thread: multi-threaded WASM needs SharedArrayBuffer, which needs the
// page to be cross-origin isolated, and nothing says the Even app's
// WebView is. These models are small enough that one thread is plenty
// (about 4% of real time on the PC, see bench/wake.ts).
ort.env.wasm.numThreads = 1

async function runner(url: string): Promise<OnnxRunner> {
  const session = await ort.InferenceSession.create(url, { executionProviders: ['wasm'] })
  const inputName = session.inputNames[0]
  const outputName = session.outputNames[0]
  return async (input, dims) => {
    const outputs = await session.run({ [inputName]: new ort.Tensor('float32', input, dims) })
    return outputs[outputName].data as Float32Array
  }
}

// baseUrl ends with a slash and points at the models folder, resolved by
// the page (a worker cannot see the page's address to resolve it itself).
export async function loadWebWakeModels(baseUrl: string): Promise<WakeModels> {
  const [melspectrogram, embedding, wakeword] = await Promise.all([
    runner(`${baseUrl}melspectrogram.onnx`),
    runner(`${baseUrl}embedding_model.onnx`),
    runner(`${baseUrl}hey_jarvis_v0.1.onnx`),
  ])
  return { melspectrogram, embedding, wakeword }
}
