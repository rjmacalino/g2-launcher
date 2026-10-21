import { bridge, status } from '../../platform/bridge'

// Who Parakeet speaks as (G2-129): everything the AI should know to answer
// as the wearer - work, studies, projects, strengths, hobbies, stories worth
// telling - typed on the companion page. Much longer than About You because
// a good answer to "what do you do for fun?" or "tell me about yourself"
// needs real material to draw on. Sent with every request while Parakeet
// listens; nothing is added to it by the AI.
const STORAGE_KEY = 'parakeet.profile'

export const PROFILE_MAX_CHARS = 3000

export async function getProfile(): Promise<string> {
  try {
    return (await bridge.getLocalStorage(STORAGE_KEY)).trim()
  } catch {
    return ''
  }
}

export function setProfile(text: string): Promise<boolean> {
  return bridge.setLocalStorage(STORAGE_KEY, text.slice(0, PROFILE_MAX_CHARS)).then(ok => {
    if (!ok) status('Failed to save the Parakeet profile')
    return ok
  })
}
