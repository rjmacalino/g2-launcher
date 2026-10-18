// Training data for a local Jarvis model (G2-89): a cloud model (the
// "teacher", Gemini) writes questions with the answers Jarvis should give,
// following the app's own chat instruction, and each is written out in
// exactly the prompt the app sends a local model (buildSystemPrompt, no
// actions). Personal questions get an invented wearer, never
// bench/persona.ts's Sam, and bench/questions.json's questions are kept
// out, so the Jarvis benchmark stays a fair test afterwards.
//
// npm run bench:chatdata -- <out.jsonl> [batches]   needs GEMINI_API_KEY
import { appendFileSync, readFileSync } from 'node:fs'
import { converse } from '../src/core/gemini'
import { CHAT_INSTRUCTION, buildSystemPrompt } from '../src/core/llmTypes'
import { llmFromEnv } from './llmEnv'

type Example = { aboutMe: string; question: string; answer: string }

const TEACHERS = [
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
]
const PER_BATCH = 8

const KINDS = [
  'general knowledge questions (science, history, geography, culture) with short factual answers',
  'Python coding questions where the answer is a short function',
  'classic algorithm interview problems, answered with the approach and Python code',
  'everyday how-to and advice questions (cooking, travel, money, health basics)',
  'small talk help: what to say or ask in a social situation',
  'job interview questions, technical and behavioural, answered as advice on what to say',
  'personal questions that can only be answered from the wearer background (aboutMe must hold the fact)',
  'quick maths, unit conversion and estimation questions',
]

const BENCH_TEXTS: string[] = JSON.parse(readFileSync('bench/questions.json', 'utf8')).map(
  (q: { text: string }) => q.text,
)

function prompt(kind: string): string {
  return `Write ${PER_BATCH} training examples for Jarvis, a voice assistant on smart glasses. Each has a question the wearer says out loud and the ideal answer.

Every example in this batch is: ${kind}.

The answer must follow Jarvis's own rules exactly:
${CHAT_INSTRUCTION}

Also:
- Answer like a helpful friend, directly, without saying you are an AI or mentioning training data.
- Most answers are 1-4 sentences; code answers are the code and then 1-2 sentences.
- Code: Python unless asked otherwise, lines under 40 characters, two-space indents.
- aboutMe: for personal questions, an invented wearer in first person ("I'm ...", 2-3 sentences) that holds the answer; otherwise "".
- Do NOT use any of these questions: ${BENCH_TEXTS.join(' / ')}

Reply with only a JSON array: [{"aboutMe": "", "question": "...", "answer": "..."}]`
}

function isExample(x: unknown): x is Example {
  const e = x as Example
  return (
    typeof e?.aboutMe === 'string' &&
    typeof e.question === 'string' &&
    typeof e.answer === 'string' &&
    e.question.length > 5 &&
    e.answer.length > 1 &&
    // The display rules: plain text only.
    !e.answer.includes('```') &&
    !e.answer.includes('**') &&
    !/^\s*[-*] /m.test(e.answer)
  )
}

function row(e: Example): string {
  const system = buildSystemPrompt({ aboutMe: e.aboutMe || undefined })
  return JSON.stringify({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: e.question },
      { role: 'assistant', content: e.answer.trim() },
    ],
  })
}

async function main() {
  const [out, batchesArg] = process.argv.slice(2)
  const llm = llmFromEnv()
  if (!out || !llm || llm.provider !== 'gemini') {
    console.log('usage: npm run bench:chatdata -- <out.jsonl> [batches]  (needs GEMINI_API_KEY)')
    process.exit(1)
  }
  const batches = Number(batchesArg ?? 80)
  let written = 0
  let teacher = 0
  for (let b = 0; b < batches && teacher < TEACHERS.length; b++) {
    const reply = await converse(
      llm.apiKey,
      [{ role: 'user', text: prompt(KINDS[b % KINDS.length]) }],
      { instruction: 'You write training data. Reply with JSON only.', maxOutputTokens: 8000 },
      TEACHERS[teacher],
    )
    if (reply.kind !== 'answer') {
      // Most likely this model's daily limit: move to the next one.
      const why = reply.kind === 'error' ? reply.message : 'actions'
      console.log(`batch ${b}: ${TEACHERS[teacher]} failed (${why})`)
      teacher += 1
      b -= 1
      continue
    }
    let items: unknown[]
    try {
      items = JSON.parse(reply.text.replace(/^```(json)?|```$/gm, '').trim())
    } catch {
      console.log(`batch ${b}: not JSON, skipped`)
      continue
    }
    const good = items.filter(isExample)
    for (const e of good) appendFileSync(out, `${row(e)}\n`)
    written += good.length
    console.log(`batch ${b} (${TEACHERS[teacher]}): +${good.length}, ${written} total`)
    await new Promise(done => setTimeout(done, 4000))
  }
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
