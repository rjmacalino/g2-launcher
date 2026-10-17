// Jarvis benchmark (G2-61): how good and how fast Jarvis is, as numbers,
// measured on the PC without the glasses. See bench/README.md for how to
// run it and docs/roadmap.md (Vision) for why these numbers.
//
// For each question in questions.json: speak it into a WAV (Windows'
// built-in voice, bench/tts.ps1), transcribe it with the same Whisper
// engine the app uses (src/core/whisperEngine.ts), send what Whisper heard
// - not the original text, so hearing mistakes count - to Gemini through
// the app's own client and prompt (src/core/gemini.ts), with a test
// persona standing in for About You and past conversations
// (bench/persona.ts), then score the answer.
//
// What the PC numbers mean: Gemini time is close to real use (the same
// network round trip a phone makes). Whisper time is the PC's, usually
// faster than a phone - Lab's live transcription probe measures the phone.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { converse, GEMINI_MODEL } from '../src/core/gemini'
import { getPipeline, transcribe, WHISPER_MODEL } from '../src/core/whisperEngine'
import { toFloat32 } from '../src/shared/pcm'
import { isSilenceHallucination, stripNonSpeech } from '../src/shared/transcript'
import { ABOUT_ME, background } from './persona'
import { readWavPcm, scoreAnswer, wordErrorRate, type Verdict } from './score'

type Question = {
  id: string
  category: string
  text: string
  expect: string[][]
}

type Result = {
  id: string
  category: string
  heard: string
  wer: number
  whisperMs: number
  geminiMs: number | null
  answer: string | null
  verdict: Verdict | 'skipped' | 'error'
}

const BENCH_DIR = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(BENCH_DIR, '..')
const AUDIO_DIR = join(BENCH_DIR, 'audio')
const RESULTS_DIR = join(BENCH_DIR, 'results')

// Pause between Gemini requests so a full run stays inside the free tier's
// per-minute request limit. converse() already retries a 429 on its own;
// this keeps a run from needing to. Override with BENCH_GEMINI_GAP_MS.
const GEMINI_GAP_MS = Number(process.env.BENCH_GEMINI_GAP_MS ?? 4000)

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

// The key is read from the environment or .env.local (gitignored), never
// from the repo, and never printed.
function geminiKey(): string | null {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY
  const envFile = join(ROOT, '.env.local')
  if (!existsSync(envFile)) return null
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*GEMINI_API_KEY\s*=\s*(.+?)\s*$/.exec(line)
    if (match) return match[1].replace(/^["']|["']$/g, '')
  }
  return null
}

function ensureAudio(questions: readonly Question[]) {
  const missing = questions.filter(q => !existsSync(join(AUDIO_DIR, `${q.id}.wav`)))
  if (missing.length === 0) return
  mkdirSync(AUDIO_DIR, { recursive: true })
  const listPath = join(AUDIO_DIR, 'pending.json')
  writeFileSync(listPath, JSON.stringify(missing.map(q => ({ id: q.id, text: q.text }))))
  console.log(`Speaking ${missing.length} question(s) with the Windows voice...`)
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

const seconds = (ms: number) => (ms / 1000).toFixed(1)
const average = (values: number[]) =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length

function delay(ms: number) {
  return new Promise(done => setTimeout(done, ms))
}

async function main() {
  const only = argValue('--only')
  const all: Question[] = JSON.parse(readFileSync(join(BENCH_DIR, 'questions.json'), 'utf8'))
  const questions = only ? all.filter(q => q.id === only || q.category === only) : all
  if (questions.length === 0) throw new Error(`no question or category named "${only}"`)

  const key = process.argv.includes('--no-gemini') ? null : geminiKey()
  if (!key) console.log('No GEMINI_API_KEY (env or .env.local): measuring hearing only.')

  ensureAudio(questions)

  const loadStart = performance.now()
  await getPipeline()
  const whisperLoadMs = performance.now() - loadStart
  console.log(`Whisper (${WHISPER_MODEL}) loaded in ${seconds(whisperLoadMs)}s\n`)

  const backgroundText = background()
  const results: Result[] = []
  for (const [index, q] of questions.entries()) {
    const pcm = readWavPcm(new Uint8Array(readFileSync(join(AUDIO_DIR, `${q.id}.wav`))))
    const whisperStart = performance.now()
    const raw = stripNonSpeech(await transcribe(toFloat32(pcm)))
    const whisperMs = performance.now() - whisperStart
    const heard = isSilenceHallucination(raw) ? '' : raw
    const result: Result = {
      id: q.id,
      category: q.category,
      heard,
      wer: wordErrorRate(q.text, heard),
      whisperMs,
      geminiMs: null,
      answer: null,
      verdict: 'skipped',
    }

    if (key && heard) {
      if (index > 0) await delay(GEMINI_GAP_MS)
      const geminiStart = performance.now()
      const reply = await converse(key, [{ role: 'user', text: heard }], {
        aboutMe: ABOUT_ME,
        background: backgroundText,
      })
      result.geminiMs = performance.now() - geminiStart
      if (reply.kind === 'answer') {
        result.answer = reply.text
        result.verdict = scoreAnswer(reply.text, q.expect)
      } else {
        result.answer = reply.kind === 'error' ? `ERROR ${reply.message}` : 'ACTIONS (unexpected)'
        result.verdict = 'error'
      }
    }

    results.push(result)
    const timing =
      result.geminiMs === null
        ? `hear ${seconds(whisperMs)}s`
        : `hear ${seconds(whisperMs)}s + answer ${seconds(result.geminiMs)}s`
    console.log(
      `[${result.verdict.toUpperCase()}] ${q.id}  (${timing}, WER ${result.wer.toFixed(2)})`,
    )
    console.log(`  heard:  ${heard || '(nothing)'}`)
    if (result.answer) console.log(`  answer: ${result.answer.replace(/\s+/g, ' ').slice(0, 220)}`)
  }

  console.log('\nBy category:')
  const categories = [...new Set(results.map(r => r.category))]
  for (const category of categories) {
    const rows = results.filter(r => r.category === category)
    const scored = rows.filter(r => r.verdict === 'pass' || r.verdict === 'fail')
    const passed = scored.filter(r => r.verdict === 'pass').length
    const answered = rows.flatMap(r => (r.geminiMs === null ? [] : [r.geminiMs]))
    console.log(
      `  ${category.padEnd(10)} pass ${passed}/${scored.length}` +
        `  review ${rows.filter(r => r.verdict === 'review').length}` +
        `  WER ${average(rows.map(r => r.wer)).toFixed(2)}` +
        `  hear ${seconds(average(rows.map(r => r.whisperMs)))}s` +
        (answered.length > 0 ? `  answer ${seconds(average(answered))}s` : ''),
    )
  }
  const totals = results.flatMap(r => (r.geminiMs === null ? [] : [r.whisperMs + r.geminiMs]))
  if (totals.length > 0) {
    console.log(
      `\nTime to answer (hear + answer): avg ${seconds(average(totals))}s, max ${seconds(Math.max(...totals))}s`,
    )
  }

  mkdirSync(RESULTS_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const out = join(RESULTS_DIR, `${stamp}.json`)
  writeFileSync(
    out,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        geminiModel: GEMINI_MODEL,
        whisperModel: WHISPER_MODEL,
        whisperLoadMs,
        results,
      },
      null,
      2,
    ),
  )
  console.log(`\nSaved ${out}`)
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
