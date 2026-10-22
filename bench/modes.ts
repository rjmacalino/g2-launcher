import { askModel } from '../src/core/llm'
import { DEFAULT_LOCAL_INSTRUCTIONS } from '../src/shared/localBrief'

// The same questions in each mode on a PC model (G2-139). The presets are
// copied from core/modes.ts's defaults, which reads storage at runtime.
// Run: npx tsx bench/modes.ts
const { MODES } = await import('../src/shared/modePresets')
const QUESTIONS = ['What do you do for fun?', 'Which is better, LeBron James or Michael Jordan?']
for (const mode of MODES) {
  for (const q of QUESTIONS) {
    const guide = [DEFAULT_LOCAL_INSTRUCTIONS, mode.preset].filter(Boolean).join('\n\n')
    const reply = await askModel(
      { provider: 'local', apiKey: 'localhost', model: 'qwen2.5:3b' },
      [{ role: 'user', text: q }],
      { guide },
    )
    const text = reply.kind === 'answer' ? reply.text : JSON.stringify(reply)
    console.log(`--- ${mode.label}: ${q}\n${text.slice(0, 220).replace(/\n/g, ' ')}\n`)
  }
}
process.exit(0)
