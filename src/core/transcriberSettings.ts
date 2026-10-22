import { bridge, status } from '../platform/bridge'

// Which speech-to-text Jarvis uses (G2-134, G2-135), chosen on the
// companion page:
// - 'whisper': on the phone, offline and free, but it transcribes only after
//   the wearer taps, so the answer waits for the transcription;
// - 'gemini-live': Gemini's live transcription (core/liveTranscribe.ts),
//   words as they are spoken (shown as live captions), so the question is
//   ready the moment the wearer taps. Free on Gemini's free tier, needs the
//   Gemini key and a connection.
export type Transcriber = 'whisper' | 'gemini-live'

export const TRANSCRIBERS: { id: Transcriber; label: string }[] = [
  { id: 'gemini-live', label: 'Gemini Live - live captions, fastest, needs the Gemini key' },
  { id: 'whisper', label: 'Whisper on the phone - offline, slower' },
]

const STORAGE_KEY = 'jarvis.transcriber'

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
