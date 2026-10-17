import { bridge, status } from '../platform/bridge'
import { getApiKey as getGeminiKey, setApiKey as setGeminiKey } from './geminiSettings'
import {
  PROVIDERS,
  defaultModel,
  modelInfo,
  providerInfo,
  type LlmConfig,
  type Provider,
  type Purpose,
} from './llmProviders'

export { PROVIDERS, providerInfo }
export type { LlmConfig, Provider, ProviderInfo, Purpose } from './llmProviders'

// Which AI answers what (G2-68, per-job since G2-77), chosen on the
// companion page. Keys: one per provider - Gemini (free tier), DeepSeek
// and Claude (paid) - typed in by the wearer and stored only in this
// device's local storage, never bundled (a released package is
// extractable, docs/platform.md). The Gemini key keeps its old storage
// slot (core/geminiSettings.ts) so an existing one is not lost.
//
// Choices: one provider and model per job (llmProviders.ts's Purpose), so
// Wingman can use the fastest model while typed questions get a smarter
// one. A job with no choice saved uses the main provider - the one picked
// before choices were per job, or failing that the first with a key - and
// that provider's default model for the job.

const PROVIDER_KEY = 'llm.provider'
const keySlot = (p: Provider) => `llm.key.${p}`
const choiceSlot = (purpose: Purpose) => `llm.use.${purpose}`

async function read(slot: string): Promise<string> {
  try {
    return (await bridge.getLocalStorage(slot)).trim()
  } catch {
    return ''
  }
}

async function write(slot: string, value: string, what: string): Promise<boolean> {
  const ok = await bridge.setLocalStorage(slot, value)
  if (!ok) status(`Failed to save ${what}`)
  return ok
}

function isProvider(x: string): x is Provider {
  return PROVIDERS.some(p => p.id === x)
}

export async function getProviderKey(provider: Provider): Promise<string | null> {
  if (provider === 'gemini') return getGeminiKey()
  const key = await read(keySlot(provider))
  return key || null
}

export function setProviderKey(provider: Provider, key: string): Promise<boolean> {
  if (provider === 'gemini') return setGeminiKey(key)
  return write(keySlot(provider), key.trim(), `the ${providerInfo(provider).label} key`)
}

// The providers there is a key for, in catalogue order.
export async function providersWithKeys(): Promise<Provider[]> {
  const keys = await Promise.all(PROVIDERS.map(p => getProviderKey(p.id)))
  return PROVIDERS.filter((_, i) => keys[i]).map(p => p.id)
}

export type Choice = { provider: Provider; model: string }

export async function getChoice(purpose: Purpose): Promise<Choice> {
  const stored = await read(choiceSlot(purpose))
  const [provider, model] = stored.split('/')
  if (provider && isProvider(provider) && modelInfo(provider, model ?? '')) {
    return { provider, model }
  }
  const main = await read(PROVIDER_KEY)
  const withKeys = await providersWithKeys()
  const fallback: Provider =
    isProvider(main) && withKeys.includes(main) ? main : (withKeys[0] ?? 'gemini')
  return { provider: fallback, model: defaultModel(fallback, purpose) }
}

export function setChoice(purpose: Purpose, choice: Choice): Promise<boolean> {
  return write(choiceSlot(purpose), `${choice.provider}/${choice.model}`, 'the model choice')
}

// Everything a request for this job needs, or null when its provider has
// no key.
export async function getLlmConfig(purpose: Purpose): Promise<LlmConfig | null> {
  const { provider, model } = await getChoice(purpose)
  const apiKey = await getProviderKey(provider)
  return apiKey ? { provider, apiKey, model } : null
}
