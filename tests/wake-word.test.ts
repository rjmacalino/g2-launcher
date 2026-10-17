import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { createWakeDetector, pcmToSampleValues, type WakeModels } from '../src/core/wakeWord'
import { loadWakeModels } from '../bench/onnxNode'
import { readWavPcm } from '../bench/score'

// Real models, real audio: two clips spoken by the Windows voice (see
// bench/wake.ts), fed in 100 ms pieces the way the glasses mic delivers
// them, after 2.5 s of quiet so the detector's warm-up is behind it, as it
// is in a continuous stream.
function clip(name: string): Float32Array {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))
  const speech = pcmToSampleValues(readWavPcm(new Uint8Array(readFileSync(path))))
  const lead = 2.5 * 16000
  const audio = new Float32Array(lead + speech.length + 16000)
  let seed = 7
  for (let i = 0; i < audio.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    audio[i] = ((seed / 0x7fffffff) * 2 - 1) * 60
  }
  audio.set(speech, lead)
  return audio
}

async function run(models: WakeModels, audio: Float32Array) {
  const detector = createWakeDetector(models)
  let wakes = 0
  let maxScore = 0
  for (let i = 0; i < audio.length; i += 1600) {
    const result = await detector.process(audio.subarray(i, i + 1600))
    if (result.detected) wakes += 1
    maxScore = Math.max(maxScore, result.maxScore)
  }
  return { wakes, maxScore }
}

describe('wake word detector', () => {
  let models: WakeModels
  beforeAll(async () => {
    models = await loadWakeModels()
  })

  it('wakes once on "Hey Jarvis"', async () => {
    const { wakes, maxScore } = await run(models, clip('hey-jarvis.wav'))
    expect(maxScore).toBeGreaterThan(0.9)
    expect(wakes).toBe(1)
  })

  it('stays quiet on "Hey Travis"', async () => {
    expect((await run(models, clip('hey-travis.wav'))).wakes).toBe(0)
  })

  it('stays quiet on room noise', async () => {
    expect((await run(models, new Float32Array(5 * 16000))).wakes).toBe(0)
  })

  it('needs a streak of chunks, not one loud one', async () => {
    const fake: WakeModels = {
      melspectrogram: async () => new Float32Array(8 * 32),
      embedding: async () => new Float32Array(96),
      wakeword: async () => new Float32Array([0.99]),
    }
    // A model that always says 0.99 still waits out warm-up and patience:
    // the 16th embedding (chunk 15) gives the first score, chunks 15-19
    // are zeroed, and chunks 20-23 are the 4 in a row.
    const detector = createWakeDetector(fake)
    const results = []
    for (let i = 0; i < 26; i++) results.push(await detector.process(new Float32Array(1280)))
    const firstWake = results.findIndex(r => r.detected)
    expect(firstWake).toBe(23)
  })
})
