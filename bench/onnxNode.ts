import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ort from 'onnxruntime-node'
import type { OnnxRunner, WakeModels } from '../src/core/wakeWord'

// The wake word models on the PC, through onnxruntime-node - the same
// files the app loads in the WebView through onnxruntime-web.
export const WAKE_MODEL_DIR = fileURLToPath(new URL('../public/models/wake/', import.meta.url))

async function runner(path: string): Promise<OnnxRunner> {
  const session = await ort.InferenceSession.create(path)
  const inputName = session.inputNames[0]
  const outputName = session.outputNames[0]
  return async (input, dims) => {
    const outputs = await session.run({ [inputName]: new ort.Tensor('float32', input, dims) })
    return outputs[outputName].data as Float32Array
  }
}

export async function loadWakeModels(dir: string = WAKE_MODEL_DIR): Promise<WakeModels> {
  const [melspectrogram, embedding, wakeword] = await Promise.all([
    runner(join(dir, 'melspectrogram.onnx')),
    runner(join(dir, 'embedding_model.onnx')),
    runner(join(dir, 'hey_jarvis_v0.1.onnx')),
  ])
  return { melspectrogram, embedding, wakeword }
}
