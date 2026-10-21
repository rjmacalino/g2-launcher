import { askModel } from '../src/core/llm'
import {
  FORCED_NOTE,
  PARAKEET_INSTRUCTION,
  parseAnswer,
  transcriptFor,
} from '../src/features/parakeet/answer'
import { llmFromEnv } from './llmEnv'

// Does Parakeet answer when it should and stay quiet when it should (G2-128)?
// Each scenario is a transcript, how many lines were already handled, and
// whether an answer is expected. Run: npx tsx bench/parakeet.ts

type Line = { speaker: string; text: string; at: number }
const l = (speaker: string, text: string): Line => ({ speaker, text, at: 0 })

const SCENARIOS: { name: string; lines: Line[]; handled: number; answer: boolean }[] = [
  {
    name: 'a clear question from them',
    lines: [l('other', 'Can you explain the difference between let and const in JavaScript?')],
    handled: 0,
    answer: true,
  },
  {
    name: 'a long problem in pieces, unlabelled',
    lines: [
      l('unknown', 'Given an array of integers nums and an integer target,'),
      l('unknown', 'return the indices of the two numbers that add up to the target.'),
      l('unknown', 'You may assume each input has exactly one solution.'),
    ],
    handled: 0,
    answer: true,
  },
  {
    name: 'the wearer answering (unlabelled)',
    lines: [
      l('other', 'How would you find duplicates in an array?'),
      l(
        'unknown',
        'So I would use a set, and as I loop through the array I check if the number is already in the set',
      ),
    ],
    handled: 1,
    answer: false,
  },
  {
    name: 'the wearer thinking aloud',
    lines: [
      l('other', 'Reverse a linked list.'),
      l('self', 'Okay, let me think about this for a second.'),
    ],
    handled: 1,
    answer: false,
  },
  {
    name: 'only an acknowledgement',
    lines: [
      l('other', 'What is a closure?'),
      l('unknown', 'A function that remembers its outer variables.'),
      l('other', 'Great, thanks.'),
    ],
    handled: 2,
    answer: false,
  },
  {
    name: 'a follow-up from them',
    lines: [
      l('other', 'What is a closure?'),
      l('unknown', 'A function that remembers its outer variables.'),
      l('other', 'Good. Can you give me a real example where you would use one?'),
    ],
    handled: 2,
    answer: true,
  },
  {
    name: 'small talk',
    lines: [l('other', 'Hi, thanks for joining. How is your day going so far?')],
    handled: 0,
    answer: false,
  },
]

const config = llmFromEnv()
if (!config) {
  console.log('No AI key found (see bench/llmEnv.ts).')
  process.exit(1)
}
let right = 0
for (const s of SCENARIOS) {
  const reply = await askModel(
    config,
    [{ role: 'user', text: transcriptFor(s.lines, s.handled) }],
    {
      instruction: PARAKEET_INSTRUCTION,
    },
  )
  const text = reply.kind === 'answer' ? parseAnswer(reply.text) : null
  const ok = (text !== null) === s.answer
  if (ok) right++
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${s.name}: ${text ? text.slice(0, 80).replace(/\n/g, ' ') : 'NONE'}`,
  )
}
const forced = await askModel(
  config,
  [{ role: 'user', text: transcriptFor(SCENARIOS[4].lines, 3) }],
  { instruction: `${PARAKEET_INSTRUCTION} ${FORCED_NOTE}` },
)
console.log(
  `tap-for-help after "thanks": ${forced.kind === 'answer' ? forced.text.slice(0, 80) : forced.kind}`,
)
console.log(`${right}/${SCENARIOS.length} as expected`)
