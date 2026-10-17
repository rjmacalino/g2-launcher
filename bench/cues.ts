// Wingman cue benchmark (G2-66): scripted conversations, each ending at
// a moment where a cue should (or should not) appear, sent through the
// app's own cue prompt and parser (src/features/live/cues.ts) and Gemini
// client. Measures time to cue and whether the cue helps - the two things
// RJ found wrong with the native Conversate (late, and trivia).
//
// npm run bench:cues                 needs GEMINI_API_KEY (.env.local)
import { askModel, describeModel } from '../src/core/llm'
import { llmFromEnv, NO_KEY_HELP } from './llmEnv'
import {
  CUE_INSTRUCTION,
  CUE_MAX_TOKENS,
  parseCue,
  transcriptForCue,
  type CueLine,
} from '../src/features/live/cues'
import { ABOUT_ME, background } from './persona'
import { scoreAnswer } from './score'

type Scenario = {
  id: string
  category: string
  lines: [speaker: 'self' | 'other', text: string][]
  // Every group must match the cue (see bench/score.ts). Empty: a person
  // judges the printed cue.
  expect?: string[][]
  // The right answer is no cue at all.
  expectNone?: boolean
}

const SCENARIOS: Scenario[] = [
  {
    id: 'interview-thread',
    category: 'interview',
    lines: [
      ['other', 'Thanks for coming in today.'],
      ['self', 'Thanks for having me.'],
      ['other', 'Can you explain the difference between a process and a thread?'],
    ],
    expect: [['memory', 'address space']],
  },
  {
    id: 'leetcode-two-sum',
    category: 'leetcode',
    lines: [
      ['other', 'Here is the problem.'],
      [
        'other',
        'Given an array of numbers and a target, how would you find the two numbers that add up to it?',
      ],
    ],
    expect: [['hash', 'map', 'dictionary']],
  },
  {
    id: 'personal-race',
    category: 'personal',
    lines: [
      ['other', 'You said you were training for something?'],
      ['self', 'Yeah, a half marathon.'],
      ['other', 'Oh nice, when is it?'],
    ],
    expect: [['march']],
  },
  {
    id: 'personal-laptop',
    category: 'personal',
    lines: [
      ['other', 'I can help you pick a laptop.'],
      ['other', 'What sort of budget are you thinking?'],
    ],
    expect: [['2000', '2,000', 'two thousand']],
  },
  {
    id: 'smalltalk-lull',
    category: 'smalltalk',
    lines: [
      ['other', 'We just got back from two weeks in Japan.'],
      ['self', 'Oh wow.'],
      ['other', 'Yeah, it was a lot of fun.'],
      ['self', 'Nice.'],
    ],
    expect: [['?']],
  },
  {
    id: 'trivia-trap',
    category: 'trivia',
    lines: [
      ['other', 'We went to Paris last summer.'],
      ['other', 'We saw the Eiffel Tower at night, it was lovely.'],
    ],
  },
  {
    id: 'goodbye',
    category: 'none',
    lines: [
      ['other', 'Anyway, I should get going.'],
      ['self', 'Yeah, me too. Good to see you.'],
      ['other', 'You too, take care!'],
    ],
    expectNone: true,
  },
]

const GAP_MS = Number(process.env.BENCH_GEMINI_GAP_MS ?? 4000)

async function main() {
  const llm = llmFromEnv()
  if (!llm) {
    console.log(NO_KEY_HELP)
    process.exit(1)
  }
  console.log(`Cues from ${describeModel(llm)}\n`)
  const times: number[] = []
  let passed = 0
  let scored = 0
  for (const [index, scenario] of SCENARIOS.entries()) {
    if (index > 0) await new Promise(done => setTimeout(done, GAP_MS))
    const lines: CueLine[] = scenario.lines.map(([speaker, text], i) => ({ speaker, text, at: i }))
    const started = performance.now()
    const reply = await askModel(llm, [{ role: 'user', text: transcriptForCue(lines) }], {
      effort: 'low',
      instruction: CUE_INSTRUCTION,
      maxOutputTokens: CUE_MAX_TOKENS,
      aboutMe: ABOUT_ME,
      background: background(),
    })
    const ms = performance.now() - started
    if (reply.kind !== 'answer') {
      console.log(`[ERROR] ${scenario.id}: ${reply.kind === 'error' ? reply.message : 'actions'}`)
      continue
    }
    times.push(ms)
    const cue = parseCue(reply.text)
    let verdict: string
    if (scenario.expectNone) verdict = cue === null ? 'pass' : 'fail'
    else if (scenario.expect) verdict = cue === null ? 'fail' : scoreAnswer(cue, scenario.expect)
    else verdict = 'review'
    if (verdict !== 'review') {
      scored += 1
      if (verdict === 'pass') passed += 1
    }
    console.log(
      `[${verdict.toUpperCase()}] ${scenario.id} (${(ms / 1000).toFixed(1)}s): ${cue ?? 'NONE'}`,
    )
  }
  if (times.length > 0) {
    const avg = times.reduce((a, b) => a + b, 0) / times.length
    console.log(
      `\nCues: ${passed}/${scored} right, time to cue avg ${(avg / 1000).toFixed(1)}s, max ${(Math.max(...times) / 1000).toFixed(1)}s` +
        ` (plus Whisper's time for the last line on the phone)`,
    )
  }
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
