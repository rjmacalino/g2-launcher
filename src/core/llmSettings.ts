import { bridge, status } from '../platform/bridge'
import { getApiKey as getGeminiKey, setApiKey as setGeminiKey } from './geminiSettings'
import { PROVIDERS, providerInfo, type LlmConfig, type Provider } from './llmProviders'

export { PROVIDERS, providerInfo }
export type { LlmConfig, Provider, ProviderInfo } from './llmProviders'

// Which AI answers for Jarvis (G2-68), chosen on the companion page:
// Gemini (free tier, the default), DeepSeek or Claude (both paid). Each
// provider keeps its own key and model, so switching back and forth does
// not lose either. Keys are typed in by the wearer and stored only in this
// device's local storage - never bundled, since a released package is
// extractable (docs/platform.md). The Gemini key keeps its old storage
// slot (core/geminiSettings.ts) so an existing one is not lost.

const PROVIDER_KEY = 'llm.provider'
const keySlot = (p: Provider) => `llm.key.${p}`
const modelSlot = (p: Provider) => `llm.model.${p}`

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

export async function getProvider(): Promise<Provider> {
  const stored = await read(PROVIDER_KEY)
  return PROVIDERS.some(p => p.id === stored) ? (stored as Provider) : 'gemini'
}

export function setProvider(provider: Provider): Promise<boolean> {
  return write(PROVIDER_KEY, provider, 'the AI provider')
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

export async function getProviderModel(provider: Provider): Promise<string> {
  const info = providerInfo(provider)
  const stored = await read(modelSlot(provider))
  return info.models.includes(stored) ? stored : info.models[0]
}

export function setProviderModel(provider: Provider, model: string): Promise<boolean> {
  return write(modelSlot(provider), model, 'the model')
}

// Everything a request needs, or null when the chosen provider has no key.
export async function getLlmConfig(): Promise<LlmConfig | null> {
  const provider = await getProvider()
  const [apiKey, model] = await Promise.all([getProviderKey(provider), getProviderModel(provider)])
  return apiKey ? { provider, apiKey, model } : null
}
