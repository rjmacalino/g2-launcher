import { bridge, status } from '../platform/bridge'

// The Gemini API key, entered once on the companion page (see
// companion/main.ts) and read here whenever something needs to answer an
// open-ended question - Jarvis's own fallback (core/voiceDispatch.ts) and
// Chat (features/chat), both. Lives in core/ for the same reason
// core/whisper.ts and core/voiceCapture.ts do: more than one feature needs
// it, and features/* modules never import each other in this codebase.
//
// Never bundled in the build - an API key in the shipped package would be
// extractable by anyone who downloads it (see docs/platform.md: "Keys must
// never ship in the package, it is extractable"). This is entered by the
// wearer at runtime and lives only in this device's own local storage,
// never in source control or the build output.
//
// Storage key kept as 'jarvis.geminiApiKey' even though this moved out of
// features/jarvis - renaming it would silently lose whatever key a wearer
// already saved under the old one.
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

// A short, persistent bit of context about the wearer - entered once on the
// companion page, same as the API key, and folded into every request's
// system instruction (see core/gemini.ts) so an answer can actually be
// tailored to them without re-explaining who they are every conversation.
// Per direct request: "I want my chatbot to know me... to tailor its
// answer for me." Shared by Jarvis's fallback and Gemini chat, same
// reasoning as the API key above - one person, one piece of context,
// regardless of which front end is asking.
const ABOUT_ME_STORAGE_KEY = 'gemini.aboutMe'

// Keeps this from growing into a full biography that eats into every
// request's own token budget for no real gain - a sentence or two of real
// identity/preference ("a backend engineer learning web dev from
// scratch", "prefers short, direct answers") does more for tailoring an
// answer than a long one does.
export const ABOUT_ME_MAX_CHARS = 300

export async function getAboutMe(): Promise<string | null> {
  try {
    const raw = await bridge.getLocalStorage(ABOUT_ME_STORAGE_KEY)
    return raw.trim().length > 0 ? raw : null
  } catch {
    return null
  }
}

export function setAboutMe(text: string): Promise<boolean> {
  return bridge
    .setLocalStorage(ABOUT_ME_STORAGE_KEY, text.slice(0, ABOUT_ME_MAX_CHARS))
    .then(ok => {
      if (!ok) status('Failed to save About You')
      return ok
    })
}
