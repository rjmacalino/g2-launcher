// The AI providers Jarvis can use (G2-68) and their models - pure data,
// so the PC benchmark (bench/) can use it without the phone's storage,
// which core/llmSettings.ts (the wearer's saved choices) needs.

export type Provider = 'gemini' | 'deepseek' | 'claude' | 'local'

// How a model trades speed for depth, as shown when picking one (G2-77).
export type Speed = 'fastest' | 'fast' | 'smart' | 'smartest'

export type ModelInfo = {
  id: string
  label: string
  speed: Speed
  // Jobs this model is the default for, ahead of the speed rule below,
  // when a benchmark showed a better fit (G2-78).
  preferFor?: readonly Purpose[]
}

export type ProviderInfo = {
  id: Provider
  label: string
  free: boolean
  // For 'local' the key field holds the PC's address instead.
  local?: boolean
  // Fastest first.
  models: readonly ModelInfo[]
  keyUrl: string
}

// Small models that fit a 4 GB graphics card, as Ollama names them.
const LOCAL_MODELS: readonly ModelInfo[] = [
  // Cue benchmark on the graphics card (driver 617.42): 0 to 3 of 6
  // right across runs, about 0.6 s a cue. LeetCode answers in under 7 s.
  { id: 'qwen2.5:3b', label: 'Qwen 2.5 3B', speed: 'fastest' },
  // 3 to 5 of 6 right, about 0.8 to 1.7 s: the better of the two.
  { id: 'llama3.2:3b', label: 'Llama 3.2 3B', speed: 'fast', preferFor: ['wingman'] },
]

// Model IDs as each provider documents them. Gemini's are the ones a free
// key listed and answered with (models.list and a timed test request,
// 2026-10-18): 3.5 Flash-Lite about 1.0 s, 3.6 Flash about 1.7 s for a
// one-line answer; each model has its own free daily limit, and Gemini 4
// Argon has none at all, so it is not offered. DeepSeek: api-docs.
// deepseek.com, 2026-10-17. Claude: Anthropic's current model list.
export const PROVIDERS: readonly ProviderInfo[] = [
  {
    id: 'gemini',
    label: 'Gemini',
    free: true,
    models: [
      { id: 'gemini-3.5-flash-lite', label: '3.5 Flash-Lite', speed: 'fastest' },
      { id: 'gemini-3.6-flash', label: '3.6 Flash', speed: 'fast' },
      { id: 'gemini-3.8-flash', label: '3.8 Flash', speed: 'smart' },
    ],
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    free: false,
    models: [
      { id: 'deepseek-flash', label: 'Flash', speed: 'fast' },
      { id: 'deepseek-v4-pro', label: 'V4 Pro', speed: 'smart' },
    ],
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'claude',
    label: 'Claude',
    free: false,
    models: [
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5', speed: 'fastest' },
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', speed: 'smart' },
      { id: 'claude-opus-5-5', label: 'Opus 5.5', speed: 'smartest' },
    ],
    keyUrl: 'https://platform.claude.com/settings/keys',
  },
  {
    // A model running on the wearer's own PC with Ollama (G2-78): free and
    // unlimited, but only while the phone can reach the PC. Timings are a
    // GTX 1650 Ti (4 GB) laptop, bench/ cue run, 2026-10-18;
    // an old driver (451.67) left Ollama on the processor at 3 to 10 s.
    id: 'local',
    label: 'Your PC',
    free: true,
    local: true,
    models: LOCAL_MODELS,
    keyUrl: 'https://ollama.com/download',
  },
]

// Ollama's OpenAI-compatible chat endpoint (docs.ollama.com/api/openai-
// compatibility) on the address typed in, e.g. "192.168.1.20" or
// "http://192.168.1.20:11434".
export function localEndpoint(address: string): string {
  let base = address.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//.test(base)) base = `http://${base}`
  if (!/:\d+$/.test(base)) base = `${base}:11434`
  return `${base}/v1/chat/completions`
}

export function providerInfo(id: Provider): ProviderInfo {
  return PROVIDERS.find(p => p.id === id) ?? PROVIDERS[0]
}

export function modelInfo(provider: Provider, model: string): ModelInfo | undefined {
  return providerInfo(provider).models.find(m => m.id === model)
}

// What each AI job is for (G2-77), each with its own model: spoken
// questions on the glasses want a quick answer, typed ones on the phone
// (code, long explanations) can wait for a better one, and a Wingman cue
// is useless if it is late.
export type Purpose = 'glasses' | 'phone' | 'wingman'

// The model a job gets until the wearer picks one.
export function defaultModel(provider: Provider, purpose: Purpose): string {
  const models = providerInfo(provider).models
  const preferred = models.find(m => m.preferFor?.includes(purpose))
  if (preferred) return preferred.id
  const pick = (...speeds: Speed[]) => {
    for (const speed of speeds) {
      const found = models.find(m => m.speed === speed)
      if (found) return found.id
    }
    return models[0].id
  }
  if (purpose === 'wingman') return pick('fastest', 'fast')
  if (purpose === 'glasses') return pick('fast', 'fastest')
  return pick('smart', 'smartest', 'fast')
}

export type LlmConfig = { provider: Provider; apiKey: string; model: string }
