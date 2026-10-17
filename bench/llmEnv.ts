import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PROVIDERS, providerInfo, type LlmConfig, type Provider } from '../src/core/llmProviders'

// Which AI the PC benchmarks use (G2-68), from environment variables or
// .env.local (gitignored, never committed):
//
//   GEMINI_API_KEY=...      ANTHROPIC_API_KEY=...      DEEPSEEK_API_KEY=...
//   LLM_PROVIDER=claude     (optional: gemini, deepseek or claude)
//   LLM_MODEL=claude-sonnet-5-5   (optional: one of that provider's models)
//
// Without LLM_PROVIDER, the first provider with a key is used, in the
// order Gemini, DeepSeek, Claude. Keys are never printed.
const KEY_VARS: Record<Provider, string> = {
  gemini: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
}

function envFile(): Record<string, string> {
  const path = fileURLToPath(new URL('../.env.local', import.meta.url))
  if (!existsSync(path)) return {}
  const values: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/.exec(line)
    if (match) values[match[1]] = match[2].replace(/^["']|["']$/g, '')
  }
  return values
}

export function llmFromEnv(): LlmConfig | null {
  const file = envFile()
  const get = (name: string) => process.env[name] || file[name] || ''
  const wanted = get('LLM_PROVIDER') as Provider
  const candidates = PROVIDERS.some(p => p.id === wanted) ? [wanted] : PROVIDERS.map(p => p.id)
  for (const provider of candidates) {
    const apiKey = get(KEY_VARS[provider])
    if (!apiKey) continue
    const info = providerInfo(provider)
    const ids = info.models.map(m => m.id)
    const model = ids.includes(get('LLM_MODEL')) ? get('LLM_MODEL') : ids[0]
    return { provider, apiKey, model }
  }
  return null
}

export const NO_KEY_HELP =
  'No AI key found. Put one of GEMINI_API_KEY, DEEPSEEK_API_KEY or ANTHROPIC_API_KEY in ' +
  '.env.local (optionally LLM_PROVIDER and LLM_MODEL too) - see bench/README.md.'
