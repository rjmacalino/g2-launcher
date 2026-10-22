import { readEditable, resetEditable, writeEditable } from './editableText'
import { DEFAULT_LOCAL_INSTRUCTIONS } from '../shared/localBrief'

export { DEFAULT_LOCAL_INSTRUCTIONS }

// The wearer's standing instructions for Jarvis (G2-95, G2-138), like a
// CLAUDE.md: typed on the phone, sent with every question to whichever model
// answers, after Jarvis's own display rules. Everything personal - who the
// wearer is, how code and explanations should be - lives here and nowhere in
// the code, so it is theirs to change. First written for the PC models
// (hence the names and the storage key, kept so a saved text survives).
const STORAGE_KEY = 'llm.local.instructions'

export const LOCAL_INSTRUCTIONS_MAX_CHARS = 5000

export function getLocalInstructions(): Promise<string> {
  return readEditable(STORAGE_KEY, DEFAULT_LOCAL_INSTRUCTIONS)
}

export function setLocalInstructions(text: string): Promise<boolean> {
  return writeEditable(
    STORAGE_KEY,
    text,
    LOCAL_INSTRUCTIONS_MAX_CHARS,
    'the instructions for Jarvis',
  )
}

export function resetLocalInstructions(): Promise<boolean> {
  return resetEditable(STORAGE_KEY, 'the instructions for Jarvis')
}
