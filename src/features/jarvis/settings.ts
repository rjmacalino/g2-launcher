import { bridge, status } from '../../platform/bridge'

// The Gemini API key, entered once on the companion page (see
// companion/main.ts) and read here whenever Jarvis needs to answer an
// open-ended question. Never bundled in the build - an API key in the
// shipped package would be extractable by anyone who downloads it (see
// docs/platform.md: "Keys must never ship in the package, it is
// extractable"). This is entered by the wearer at runtime and lives only in
// this device's own local storage, never in source control or the build
// output.
const STORAGE_KEY = 'jarvis.geminiApiKey'

export async function getApiKey(): Promise<string | null> {
  try {
    const raw = await bridge.getLocalStorage(STORAGE_KEY)
    return raw.trim().length > 0 ? raw : null
  } catch {
    return null
  }
}

export function setApiKey(key: string): Promise<boolean> {
  return bridge.setLocalStorage(STORAGE_KEY, key).then(ok => {
    if (!ok) status('Failed to save Gemini API key')
    return ok
  })
}
