import { askModel } from '../src/core/llm'
import { DEFAULT_LOCAL_INSTRUCTIONS } from '../src/shared/localBrief'

// The PC models with the default brief on everyday and coding questions
// (G2-137). Run: npx tsx bench/localBrief.ts
const QUESTIONS = [
  'Which is better, LeBron James or Michael Jordan?',
  'What should I eat for dinner tonight?',
  'Write a JavaScript function that reverses a string.',
]
for (const model of ['qwen2.5:3b', 'llama3.2:3b']) {
  for (const q of QUESTIONS) {
    const began = Date.now()
    const reply = await askModel(
      { provider: 'local', apiKey: 'localhost', model },
      [{ role: 'user', text: q }],
      { guide: DEFAULT_LOCAL_INSTRUCTIONS },
    )
    const text = reply.kind === 'answer' ? reply.text : JSON.stringify(reply)
    console.log(
      `--- ${model} (${((Date.now() - began) / 1000).toFixed(1)}s): ${q}\n${text.slice(0, 300)}\n`,
    )
  }
}
process.exit(0)
