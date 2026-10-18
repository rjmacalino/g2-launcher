import { converse as converseGemini } from './gemini'
import { status } from '../platform/bridge'
import type { ConverseOptions, LlmResult, LlmTurn } from './llmTypes'
import { localEndpoint, providerInfo, type LlmConfig } from './llmProviders'

// The one way Jarvis talks to an AI (G2-68): the same conversation and
// options go to whichever provider the wearer chose on the companion page
// (core/llmSettings.ts). DeepSeek and Claude are loaded only when chosen,
// so the Anthropic SDK in particular adds nothing to the app until then.
export async function askModel(
  config: LlmConfig,
  turns: readonly LlmTurn[],
  options: ConverseOptions = {},
): Promise<LlmResult> {
  switch (config.provider) {
    case 'deepseek': {
      const { converseDeepSeek } = await import('./deepseek')
      return converseDeepSeek(config.apiKey, config.model, turns, options)
    }
    case 'local': {
      // The "key" for a local model is the PC's address (G2-78).
      const { converseDeepSeek } = await import('./deepseek')
      // No actions: a 3B model calls them when it should answer (G2-78,
      // "There was nothing to add." for a LeetCode question in the
      // simulator). Commands like timers never reach the AI anyway.
      const { functions: _unused, ...questionOnly } = options
      return converseDeepSeek('', config.model, turns, questionOnly, {
        endpoint: localEndpoint(config.apiKey),
        label: 'Your PC',
        deepseek: false,
      })
    }
    case 'claude': {
      const { converseClaude } = await import('./claude')
      return converseClaude(config.apiKey, config.model, turns, options)
    }
    default:
      return askGemini(config, turns, options)
  }
}

// Gemini's free tier is a daily allowance per model (docs/platform.md), so
// a 429 on one model says nothing about the others (G2-85: a phone
// question failed with 429 after the day's requests went on one model).
// The chosen model goes first; on a 429 the next one is tried, and models
// that ran out are skipped until Google's day turns over (Pacific time).
const outOfQuota = new Map<string, string>()

function googleDay(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
}

async function askGemini(
  config: LlmConfig,
  turns: readonly LlmTurn[],
  options: ConverseOptions,
): Promise<LlmResult> {
  const today = googleDay()
  const others = providerInfo('gemini')
    .models.map(m => m.id)
    .filter(id => id !== config.model)
  const order = [config.model, ...others].filter(id => outOfQuota.get(id) !== today)
  for (const model of order) {
    const result = await converseGemini(config.apiKey, turns, options, model)
    if (result.kind !== 'error' || !result.message.includes('429')) return result
    outOfQuota.set(model, today)
    status(`Gemini ${model}: free daily limit reached, trying another model`)
  }
  return {
    kind: 'error',
    message:
      "Gemini's free daily limit is used up on every model - try again tomorrow, or choose another AI in Settings",
  }
}

// For messages and status lines: "Claude (claude-opus-5-5)".
export function describeModel(config: LlmConfig): string {
  return `${providerInfo(config.provider).label} (${config.model})`
}
