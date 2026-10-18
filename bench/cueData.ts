// Training data for a local Wingman model (G2-79): a cloud model (the
// "teacher", Gemini by default) invents short conversations, each with a
// made-up wearer and the ideal cue - or NONE - and every example is
// written out in exactly the prompt the app sends (cues.ts and
// buildSystemPrompt), so a small model fine-tuned on it learns the real
// task. Each example gets its own invented person, never bench/persona.ts's
// Sam, and the teacher is told to avoid bench/cues.ts's situations, so the
// cue benchmark stays a fair test afterwards.
//
// npm run bench:cuedata -- <out.jsonl> [batches]   needs GEMINI_API_KEY
import { appendFileSync } from 'node:fs'
import { converse } from '../src/core/gemini'
import { buildSystemPrompt } from '../src/core/llmTypes'
import { buildDigest } from '../src/features/chat/digest'
import type { ChatSession } from '../src/features/chat/store'
import { CUE_INSTRUCTION, transcriptForCue, type CueLine } from '../src/features/live/cues'
import { llmFromEnv } from './llmEnv'

type Example = {
  aboutMe: string
  notes: { question: string; answer: string }[]
  lines: ['self' | 'other', string][]
  cue: string
}

// Rotated so each model's own free daily limit is used.
const TEACHERS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite']
const PER_BATCH = 10

const KINDS = [
  'a job interview where the wearer is asked a technical computer science question (cue: the key point of the answer)',
  'a coding interview where the wearer is given a classic algorithm problem (cue: the approach and complexity)',
  'a chat where someone asks the wearer about a fact found ONLY in their background or notes (cue: that fact)',
  'small talk that stalls with short replies (cue: a natural, specific follow-up question)',
  'a chat where the other person mentions a famous place, film or person (cue: NONE - no trivia)',
  'a conversation that is flowing fine with nothing to add (cue: NONE)',
  'a goodbye or wrap-up (cue: NONE)',
  'a behavioural interview question like a time you handled conflict (cue: a short pointer drawn from their background)',
]

function prompt(kind: string): string {
  return `Write ${PER_BATCH} training examples for a smart-glasses assistant that flashes ONE short cue (max 12 words) during a live conversation, or NONE when nothing would genuinely help.

Every example in this batch is: ${kind}.

Rules:
- Invent a different wearer for each example: name, job, city, hobbies, plans, preferences, 2-4 sentences, written in first person ("I'm ...").
- notes: 0-2 earlier questions the wearer asked their assistant, with answers, that may hold a needed fact (a budget, a date, a choice).
- lines: 2-6 transcript lines, "self" is the wearer, "other" the other person; the last line is the moment to cue.
- cue: what the wearer needs right now, at most 12 words, plain text; or exactly NONE.
- Facts in a cue must come from the wearer's background or notes, never invented.
- Vary topics widely. Do NOT use: a half marathon, a laptop budget, a trip to Japan, the Eiffel Tower or Paris, Two Sum, or processes vs threads.

Reply with only a JSON array: [{"aboutMe": "...", "notes": [{"question": "...", "answer": "..."}], "lines": [["other", "..."], ["self", "..."]], "cue": "..."}]`
}

function sessionsFrom(notes: Example['notes']): ChatSession[] {
  return notes.map((note, i) => {
    const at = Date.now() - (i + 1) * 86_400_000
    return {
      id: `n${i}`,
      title: note.question,
      updatedAt: at,
      messages: [
        { role: 'user', text: note.question, timestamp: at },
        { role: 'model', text: note.answer, timestamp: at + 1000 },
      ],
    }
  })
}

function isExample(x: unknown): x is Example {
  const e = x as Example
  return (
    typeof e?.aboutMe === 'string' &&
    Array.isArray(e.notes) &&
    Array.isArray(e.lines) &&
    e.lines.length > 0 &&
    e.lines.every(l => (l[0] === 'self' || l[0] === 'other') && typeof l[1] === 'string') &&
    typeof e.cue === 'string' &&
    e.cue.split(/\s+/).length <= 14
  )
}

// One training row: the app's exact system prompt and transcript, and the
// ideal reply.
function row(e: Example): string {
  const lines: CueLine[] = e.lines.map(([speaker, text], at) => ({ speaker, text, at }))
  const system = buildSystemPrompt({
    instruction: CUE_INSTRUCTION,
    aboutMe: e.aboutMe,
    background: buildDigest(sessionsFrom(e.notes), null),
  })
  return JSON.stringify({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: transcriptForCue(lines) },
      { role: 'assistant', content: e.cue.trim() },
    ],
  })
}

async function main() {
  const [out, batchesArg] = process.argv.slice(2)
  const llm = llmFromEnv()
  if (!out || !llm || llm.provider !== 'gemini') {
    console.log('usage: npm run bench:cuedata -- <out.jsonl> [batches]  (needs GEMINI_API_KEY)')
    process.exit(1)
  }
  const batches = Number(batchesArg ?? 40)
  let written = 0
  let teacher = 0
  for (let b = 0; b < batches && teacher < TEACHERS.length; b++) {
    const kind = KINDS[b % KINDS.length]
    const reply = await converse(
      llm.apiKey,
      [{ role: 'user', text: prompt(kind) }],
      { instruction: 'You write training data. Reply with JSON only.', maxOutputTokens: 8000 },
      TEACHERS[teacher],
    )
    if (reply.kind !== 'answer') {
      // Most likely this model's daily limit: move to the next one.
      console.log(
        `batch ${b}: ${TEACHERS[teacher]} failed (${reply.kind === 'error' ? reply.message : 'actions'})`,
      )
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
