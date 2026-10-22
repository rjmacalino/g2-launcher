import { writeFileSync } from 'node:fs'
import { askModel } from '../src/core/llm'
import { CHAT_INSTRUCTION, WEARER_INSTRUCTION } from '../src/core/llmTypes'
import { DEFAULT_LOCAL_INSTRUCTIONS } from '../src/shared/localBrief'
import { MODES, type ModeId } from '../src/shared/modePresets'
import { llmFromEnv } from './llmEnv'

// The same questions in each mode on each cloud AI with a key in .env.local
// (G2-143), built the way features/chat/assistant.ts builds them: Jarvis's
// rules (or the wearer's, in Interview), then the shared instructions, then
// the mode's preset. Prints time and the start of each answer, and saves the
// full answers under bench/results/. Run: npx tsx bench/modesCompare.ts [gemini|deepseek]
// Optional: a model per provider, e.g. GEMINI_MODEL=gemini-3.8-flash.

// A made-up candidate, so Interview answers have facts to use. The real one
// lives in the wearer's Settings, never in the code.
const SAMPLE_PROFILE =
  'ABOUT ME (sample). I am a full-stack web developer with six years in industry: ' +
  'data analyst for four years, then web developer building React and Shopify sites. ' +
  'I build a Next.js e-commerce store with Stripe on the side. For fun I play ' +
  'badminton and build game mods in Lua.'

const QUESTIONS: { mode: ModeId; text: string }[] = [
  { mode: 'auto', text: 'What is the difference between let and const in JavaScript?' },
  {
    mode: 'coding',
    text:
      'Given an array of integers nums and an integer target, return the indices of the ' +
      'two numbers that add up to target. Each input has exactly one solution.',
  },
  { mode: 'interview', text: 'Tell me about yourself.' },
  { mode: 'interview', text: 'What do you do for fun?' },
  { mode: 'interview', text: 'Why should we hire you?' },
  { mode: 'general', text: 'Which is better, LeBron James or Michael Jordan?' },
]

const results: unknown[] = []
const ONLY = process.argv[2]
for (const provider of ['gemini', 'deepseek'] as const) {
  if (ONLY && provider !== ONLY) continue
  process.env.LLM_PROVIDER = provider
  const wanted = process.env[`${provider.toUpperCase()}_MODEL`]
  if (wanted) process.env.LLM_MODEL = wanted
  else delete process.env.LLM_MODEL
  const config = llmFromEnv()
  if (!config || config.provider !== provider) {
    console.log(`(${provider}: no key in .env.local, skipped)\n`)
    continue
  }
  for (const q of QUESTIONS) {
    const mode = MODES.find(m => m.id === q.mode)!
    const preset = q.mode === 'interview' ? `${mode.preset}\n\n${SAMPLE_PROFILE}` : mode.preset
    const began = Date.now()
    const reply = await askModel(config, [{ role: 'user', text: q.text }], {
      instruction: q.mode === 'interview' ? WEARER_INSTRUCTION : CHAT_INSTRUCTION,
      guide: [DEFAULT_LOCAL_INSTRUCTIONS, preset].filter(Boolean).join('\n\n'),
    })
    const seconds = (Date.now() - began) / 1000
    const text = reply.kind === 'answer' ? reply.text : JSON.stringify(reply)
    results.push({ provider, model: config.model, mode: q.mode, question: q.text, seconds, text })
    console.log(`--- ${provider} ${config.model} | ${mode.label} | ${seconds.toFixed(1)}s`)
    console.log(`Q: ${q.text}`)
    console.log(`${text.slice(0, 400).replace(/\n/g, ' | ')}\n`)
  }
}
const file = `bench/results/modes-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
writeFileSync(file, JSON.stringify(results, null, 2))
console.log(`Full answers: ${file}`)
process.exit(0)
