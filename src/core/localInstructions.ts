import { bridge, status } from '../platform/bridge'
import { DEFAULT_LOCAL_INSTRUCTIONS } from '../shared/localBrief'

export { DEFAULT_LOCAL_INSTRUCTIONS }

// The wearer's standing instructions for Jarvis (G2-95, G2-138), like a
// CLAUDE.md: typed on the phone, sent with every question to whichever model
// answers, after Jarvis's own display rules. Everything personal - who the
// wearer is, how code and explanations should be - lives here and nowhere in
// the code, so it is theirs to change. First written for the PC models
// (hence the names and the storage key, kept so a saved text survives).
const STORAGE_KEY = 'llm.local.instructions'

export const LOCAL_INSTRUCTIONS_MAX_CHARS = 1500

// What the wearer saved, or null when nothing is saved.
export async function getSavedLocalInstructions(): Promise<string | null> {
  try {
    const saved = (await bridge.getLocalStorage(STORAGE_KEY)).trim()
    return saved || null
  } catch {
    return null
  }
}

export async function getLocalInstructions(): Promise<string> {
  return (await getSavedLocalInstructions()) ?? DEFAULT_LOCAL_INSTRUCTIONS
}

export function setLocalInstructions(text: string): Promise<boolean> {
  return bridge
    .setLocalStorage(STORAGE_KEY, text.trim().slice(0, LOCAL_INSTRUCTIONS_MAX_CHARS))
    .then(ok => {
      if (!ok) status('Failed to save the instructions for your PC')
      return ok
    })
}
