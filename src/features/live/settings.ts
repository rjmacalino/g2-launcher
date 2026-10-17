import { bridge, status } from '../../platform/bridge'

// Wingman's prep notes (G2-66): background for the next conversation,
// typed on the companion page before it starts - who it is with, what it
// is about, what the wearer wants out of it. Sent with every cue request,
// after About You, so cues can be about this conversation specifically.
// Same idea as the native Conversate's Prep Notes.
const STORAGE_KEY = 'live.prepNotes'

export const PREP_NOTES_MAX_CHARS = 1000

export async function getPrepNotes(): Promise<string> {
  try {
    return (await bridge.getLocalStorage(STORAGE_KEY)).trim()
  } catch {
    return ''
  }
}

export function setPrepNotes(text: string): Promise<boolean> {
  return bridge.setLocalStorage(STORAGE_KEY, text.slice(0, PREP_NOTES_MAX_CHARS)).then(ok => {
    if (!ok) status('Failed to save Wingman prep notes')
    return ok
  })
}
