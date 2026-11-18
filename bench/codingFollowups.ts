import { askModel } from '../src/core/llm'
import { WEARER_INSTRUCTION } from '../src/core/llmTypes'
import defaults from '../src/defaults/instructions.json'
import { DEFAULT_LOCAL_INSTRUCTIONS } from '../src/shared/localBrief'
import { MODES } from '../src/shared/modePresets'
import { llmFromEnv } from './llmEnv'

// Code mode after the solution (G2-154): the interviewer asks what a concept
// is, or why the code was written that way. Prints the solution, then each
// follow-up's answer, to read: is it simple, first person, and tied to the
// code just written? Run: npx tsx bench/codingFollowups.ts [deepseek|gemini]

const PROBLEM =
  'Two sum. Given an array of integers nums and an integer target, return indices of the ' +
  'two numbers such that they add up to target. Each input has exactly one solution. ' +
  'Example: nums 2, 7, 11, 15, target 9, output 0, 1. Constraints: nums length up to 10 ' +
  'to the 4. Starter code: class Solution, def two sum, self, nums colon list of int, ' +
  'target colon int, arrow list of int.'

const FOLLOW_UPS = [
  'What is a dictionary, and why did you use one?',
  'What is a lambda?',
  'What is a tuple, and could you have used one here?',
  'Walk me through your thought process again.',
]

process.env.LLM_PROVIDER = process.argv[2] ?? 'deepseek'
const config = llmFromEnv()
if (!config) {
  console.log('No key in .env.local.')
  process.exit(1)
}
const coding = MODES.find(m => m.id === 'coding')!
const options = {
  instruction: WEARER_INSTRUCTION,
  guide: [
    DEFAULT_LOCAL_INSTRUCTIONS,
    coding.preset,
    defaults.languageRule.split('{language}').join('Python'),
  ].join('\n\n'),
}
const first = await askModel(config, [{ role: 'user', text: PROBLEM }], options)
const solution = first.kind === 'answer' ? first.text : JSON.stringify(first)
console.log(`=== SOLUTION\n${solution}\n`)
for (const question of FOLLOW_UPS) {
  const reply = await askModel(
    config,
    [
      { role: 'user', text: PROBLEM },
      { role: 'model', text: solution },
      { role: 'user', text: question },
    ],
    options,
  )
  console.log(`=== ${question}\n${reply.kind === 'answer' ? reply.text : JSON.stringify(reply)}\n`)
}
process.exit(0)
