// The AI providers Jarvis can use (G2-68) and their models - pure data,
// so the PC benchmark (bench/) can use it without the phone's storage,
// which core/llmSettings.ts (the wearer's saved choice) needs.

export type Provider = 'gemini' | 'deepseek' | 'claude'

export type ProviderInfo = {
  id: Provider
  label: string
  free: boolean
  models: readonly string[]
  keyUrl: string
}

// Model IDs as each provider documents them (Gemini: core/gemini.ts;
// DeepSeek: api-docs.deepseek.com, 2026-10-17; Claude: Anthropic's current
// model list - Opus 5.5 is the default, the others are the wearer's call).
export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: 'gemini',
    label: 'Gemini',
    free: true,
    models: ['gemini-3.8-flash'],
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    free: false,
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'claude',
    label: 'Claude',
    free: false,
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    keyUrl: 'https://platform.claude.com/settings/keys',
  },
]

export function providerInfo(id: Provider): ProviderInfo {
  return PROVIDERS.find(p => p.id === id) ?? PROVIDERS[0]
}

export type LlmConfig = { provider: Provider; apiKey: string; model: string }
