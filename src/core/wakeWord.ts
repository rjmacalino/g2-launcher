// "Hey Jarvis" detection (G2-63), a port of openWakeWord's streaming
// pipeline (github.com/dscripka/openWakeWord, openwakeword/utils.py
// AudioFeatures and model.py Model.predict, read from source, v0.5.1
// models). Three small ONNX models run per 80 ms of audio:
//
// 1. melspectrogram: the last 1280 samples plus 480 of context, as raw
//    16-bit values in float32 (not scaled to [-1, 1]), become mel frames of
//    32 bins; openWakeWord then applies x / 10 + 2 to every value.
// 2. embedding: the newest 76 mel frames, shaped [1, 76, 32, 1], become
//    one 96-number embedding.
// 3. hey_jarvis: the newest 16 embeddings, shaped [1, 16, 96], become one
//    score from 0 to 1. openWakeWord's default threshold is 0.5, and it
//    zeroes the first 5 scores while its buffers fill.
//
// Pure: the models are passed in, so the same code runs in the phone's
// WebView (onnxruntime-web, core/wakeWorker.ts) and on the PC
// (onnxruntime-node, tests and bench/wake.ts). The models themselves are
// in public/models/wake (CC BY-NC-SA 4.0, see the NOTICE there).

// Runs one model on one input tensor and returns the output's values.
export type OnnxRunner = (input: Float32Array, dims: readonly number[]) => Promise<Float32Array>

export type WakeModels = {
  melspectrogram: OnnxRunner
  embedding: OnnxRunner
  wakeword: OnnxRunner
}

export const CHUNK_SAMPLES = 1280
const CONTEXT_SAMPLES = 480
const MEL_BINS = 32
const EMBEDDING_WINDOW = 76
const EMBEDDING_SIZE = 96
const WAKE_FRAMES = 16
const WARMUP_SCORES = 5
// One detection per utterance: the score stays high for several chunks
// while "Hey Jarvis" is being said, and each would otherwise fire again.
const COOLDOWN_CHUNKS = 25 // 2 seconds
// openWakeWord's "patience": this many chunks in a row at or above the
// threshold before it counts. Measured with bench/wake.ts (Windows
// voices): "Hey Jarvis" held 7 to 9 chunks, while "Hey Charles" - the one
// phrase that fooled a single-chunk trigger, peaking at 0.99 - held only 1
// to 3. Costs about 240 ms of response. [Synthetic voices only - re-tune
// against a real wearer's voice.]
const DEFAULT_PATIENCE = 4

export type WakeOptions = { threshold?: number; patience?: number }

// scores holds one score per 80 ms chunk processed by this call.
export type WakeResult = { detected: boolean; maxScore: number; scores: number[] }

export function createWakeDetector(
  models: WakeModels,
  { threshold = 0.5, patience = DEFAULT_PATIENCE }: WakeOptions = {},
) {
  let streak = 0
  let context = new Float32Array(CONTEXT_SAMPLES)
  let pending = new Float32Array(0)
  // openWakeWord starts its mel buffer as 76 rows of ones.
  let mel: Float32Array[] = Array.from({ length: EMBEDDING_WINDOW }, () =>
    new Float32Array(MEL_BINS).fill(1),
  )
  let embeddings: Float32Array[] = []
  let scoresSeen = 0
  let cooldown = 0

  async function processChunk(chunk: Float32Array): Promise<number> {
    const audio = new Float32Array(CONTEXT_SAMPLES + CHUNK_SAMPLES)
    audio.set(context)
    audio.set(chunk, CONTEXT_SAMPLES)
    context = audio.slice(audio.length - CONTEXT_SAMPLES)

    const spec = await models.melspectrogram(audio, [1, audio.length])
    for (let row = 0; row + MEL_BINS <= spec.length; row += MEL_BINS) {
      const frame = new Float32Array(MEL_BINS)
      for (let bin = 0; bin < MEL_BINS; bin++) frame[bin] = spec[row + bin] / 10 + 2
      mel.push(frame)
    }
    mel = mel.slice(-EMBEDDING_WINDOW)

    const window = new Float32Array(EMBEDDING_WINDOW * MEL_BINS)
    mel.forEach((frame, i) => window.set(frame, i * MEL_BINS))
    const embedding = await models.embedding(window, [1, EMBEDDING_WINDOW, MEL_BINS, 1])
    embeddings.push(embedding.slice(0, EMBEDDING_SIZE))
    embeddings = embeddings.slice(-WAKE_FRAMES)
    if (embeddings.length < WAKE_FRAMES) return 0

    const features = new Float32Array(WAKE_FRAMES * EMBEDDING_SIZE)
    embeddings.forEach((e, i) => features.set(e, i * EMBEDDING_SIZE))
    const score = (await models.wakeword(features, [1, WAKE_FRAMES, EMBEDDING_SIZE]))[0] ?? 0
    scoresSeen += 1
    return scoresSeen <= WARMUP_SCORES ? 0 : score
  }

  return {
    // Takes any amount of 16 kHz audio as raw 16-bit sample values (not
    // scaled), processes every complete 80 ms chunk, and keeps the rest
    // for next time. Calls must not overlap: await each before the next.
    async process(samples: Float32Array): Promise<WakeResult> {
      const all = new Float32Array(pending.length + samples.length)
      all.set(pending)
      all.set(samples, pending.length)
      let offset = 0
      let maxScore = 0
      let detected = false
      const scores: number[] = []
      while (all.length - offset >= CHUNK_SAMPLES) {
        const score = await processChunk(all.subarray(offset, offset + CHUNK_SAMPLES))
        offset += CHUNK_SAMPLES
        scores.push(score)
        maxScore = Math.max(maxScore, score)
        streak = score >= threshold ? streak + 1 : 0
        if (cooldown > 0) {
          cooldown -= 1
        } else if (streak >= patience) {
          detected = true
          cooldown = COOLDOWN_CHUNKS
          streak = 0
        }
      }
      pending = all.slice(offset)
      return { detected, maxScore, scores }
    },
  }
}

// The glasses' 16-bit little-endian PCM as raw sample values, the scale
// the melspectrogram model was trained on (shared/pcm.ts's toFloat32
// scales to [-1, 1] for Whisper instead).
export function pcmToSampleValues(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Float32Array(Math.floor(bytes.length / 2))
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true)
  return out
}
