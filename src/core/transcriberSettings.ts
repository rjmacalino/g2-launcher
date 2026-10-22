import { bridge, status } from '../platform/bridge'

// Which speech-to-text Parakeet uses (G2-134), chosen on the companion page:
// - 'whisper': on the phone, offline and free, but it waits for a pause and
//   then transcribes, so captions run several seconds behind;
// - 'gemini-live': Gemini's live transcription (core/liveTranscribe.ts),
//   words as they are spoken, free on Gemini's free tier, needs the Gemini
//   key and a connection.
export type Transcriber = 'whisper' | 'gemini-live'

export const TRANSCRIBERS: { id: Transcriber; label: string }[] = [
  { id: 'gemini-live', label: 'Gemini Live - live captions, needs the Gemini key' },
  { id: 'whisper', label: 'Whisper on the phone - offline, a few seconds behind' },
]

const STORAGE_KEY = 'parakeet.transcriber'

export async function getTranscriber(): Promise<Transcriber> {
  try {
    const saved = await bridge.getLocalStorage(STORAGE_KEY)
    return TRANSCRIBERS.some(t => t.id === saved) ? (saved as Transcriber) : 'whisper'
  } catch {
    return 'whisper'
  }
}

export async function setTranscriber(choice: Transcriber): Promise<boolean> {
  const ok = await bridge.setLocalStorage(STORAGE_KEY, choice)
  if (!ok) status('Failed to save the transcriber setting')
  return ok
}
