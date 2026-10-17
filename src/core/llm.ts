import { converse as converseGemini } from './gemini'
import type { ConverseOptions, LlmResult, LlmTurn } from './llmTypes'
import { providerInfo, type LlmConfig } from './llmProviders'

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
    case 'claude': {
      const { converseClaude } = await import('./claude')
      return converseClaude(config.apiKey, config.model, turns, options)
    }
    default:
      return converseGemini(config.apiKey, turns, options)
  }
}

// For messages and status lines: "Claude (claude-opus-5-5)".
export function describeModel(config: LlmConfig): string {
  return `${providerInfo(config.provider).label} (${config.model})`
}
