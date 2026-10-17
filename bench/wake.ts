// "Hey Jarvis" benchmark (G2-63): speaks phrases that should and should
// not wake Jarvis with every installed Windows voice, runs each through
// the app's own detector (src/core/wakeWord.ts) with the same models, and
// reports the highest score and whether it fired.
//
// npm run bench:wake            all phrases, default threshold 0.5
// npm run bench:wake -- 0.3     a different threshold
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createWakeDetector, pcmToSampleValues } from '../src/core/wakeWord'
import { loadWakeModels } from './onnxNode'
import { readWavPcm } from './score'

const BENCH_DIR = fileURLToPath(new URL('.', import.meta.url))
const AUDIO_DIR = join(BENCH_DIR, 'audio', 'wake')

const SHOULD_WAKE = [
  'Hey Jarvis',
  'Hey Jarvis, set a timer for five minutes',
  "Hey Jarvis, what's the weather like today?",
  'Okay. Hey Jarvis, add milk to my shopping list.',
]
const SHOULD_NOT_WAKE = [
  'Hey Travis',
  'Hey there, how are you doing?',
  'Jarvis is the assistant in Iron Man',
  'Set a timer for five minutes',
  'Harvest season starts in March',
  'Hey Charles, have you seen my keys?',
]
const VOICES = ['Microsoft Zira Desktop', 'Microsoft Hazel Desktop']

// Real use is one continuous stream, so the detector's 1.7 second warm-up
// happens once, long before anyone speaks. Each clip gets that much quiet
// room noise first, and a second after, so it is judged the same way.
const LEAD_SECONDS = 2.5
const TAIL_SECONDS = 1

type Clip = { id: string; text: string; voice: string; shouldWake: boolean }

function clips(): Clip[] {
  const out: Clip[] = []
  for (const voice of VOICES) {
    const tag = voice.split(' ')[1].toLowerCase()
    SHOULD_WAKE.forEach((text, i) =>
      out.push({ id: `yes-${i}-${tag}`, text, voice, shouldWake: true }),
    )
    SHOULD_NOT_WAKE.forEach((text, i) =>
      out.push({ id: `no-${i}-${tag}`, text, voice, shouldWake: false }),
    )
  }
  return out
}

function ensureAudio(all: readonly Clip[]) {
  const missing = all.filter(c => !existsSync(join(AUDIO_DIR, `${c.id}.wav`)))
  if (missing.length === 0) return
  mkdirSync(AUDIO_DIR, { recursive: true })
  const listPath = join(AUDIO_DIR, 'pending.json')
  writeFileSync(listPath, JSON.stringify(missing))
  console.log(`Speaking ${missing.length} clip(s)...`)
  const run = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(BENCH_DIR, 'tts.ps1'),
      listPath,
      AUDIO_DIR,
    ],
    { encoding: 'utf8' },
  )
  if (run.status !== 0) throw new Error(`tts.ps1 failed: ${run.stderr || run.stdout}`)
}

// Deterministic low-level noise, so runs are repeatable.
function roomNoise(seconds: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * 16000))
  let seed = 12345
  for (let i = 0; i < out.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    out[i] = ((seed / 0x7fffffff) * 2 - 1) * 60
  }
  return out
}

async function main() {
  const threshold = Number(process.argv[2] ?? 0.5)
  const all = clips()
  ensureAudio(all)
  const models = await loadWakeModels()

  let correct = 0
  let falseWakes = 0
  let missed = 0
  for (const clip of all) {
    const speech = pcmToSampleValues(
      readWavPcm(new Uint8Array(readFileSync(join(AUDIO_DIR, `${clip.id}.wav`)))),
    )
    const lead = roomNoise(LEAD_SECONDS)
    const tail = roomNoise(TAIL_SECONDS)
    const audio = new Float32Array(lead.length + speech.length + tail.length)
    audio.set(lead)
    audio.set(speech, lead.length)
    audio.set(tail, lead.length + speech.length)

    const detector = createWakeDetector(models, { threshold })
    const started = performance.now()
    // Fed in 100 ms pieces, the size the glasses mic delivers.
    let detected = false
    let maxScore = 0
    const scores: number[] = []
    for (let i = 0; i < audio.length; i += 1600) {
      const result = await detector.process(audio.subarray(i, i + 1600))
      detected ||= result.detected
      maxScore = Math.max(maxScore, result.maxScore)
      scores.push(...result.scores)
    }
    const above = scores.filter(s => s >= threshold).length
    const ms = performance.now() - started
    const ok = detected === clip.shouldWake
    if (ok) correct += 1
    else if (detected) falseWakes += 1
    else missed += 1
    console.log(
      `${ok ? 'OK  ' : 'BAD '} ${clip.shouldWake ? 'wake ' : 'quiet'} score ${maxScore.toFixed(2)} above ${above}  ${clip.voice.split(' ')[1].padEnd(5)} "${clip.text}"  (${(ms / 10 / (audio.length / 16000)).toFixed(1)}% of real time)`,
    )
  }
  console.log(
    `\nThreshold ${threshold}: ${correct}/${all.length} right, ${missed} missed wake(s), ${falseWakes} false wake(s)`,
  )
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
