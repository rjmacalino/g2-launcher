import { bridge, status } from '../platform/bridge'

// Which speech-to-text Jarvis uses (G2-134, G2-135, G2-157), chosen on the
// companion page:
// - 'whisper': on the phone, offline and free, but it transcribes only after
//   the wearer taps, so the answer waits for the transcription;
// - 'gemini-live': Gemini's live transcription (core/liveTranscribe.ts),
//   words as they are spoken (shown as live captions), so the question is
//   ready the moment the wearer taps. Free on Gemini's free tier, needs the
//   Gemini key and a connection;
// - 'deepgram': Deepgram Nova-3 (core/deepgramTranscribe.ts), live like
//   Gemini Live, with a word list for coding terms. Needs a Deepgram key.
export type Transcriber = 'whisper' | 'gemini-live' | 'deepgram'

export const TRANSCRIBERS: { id: Transcriber; label: string }[] = [
  { id: 'gemini-live', label: 'Gemini Live - live captions, needs the Gemini key' },
  { id: 'deepgram', label: 'Deepgram Nova-3 - live captions, needs a Deepgram key' },
  { id: 'whisper', label: 'Whisper on the phone - offline, slower' },
]

// What the listening screen calls each one.
export const TRANSCRIBER_NAMES: Record<Transcriber, string> = {
  'gemini-live': 'Gemini Live',
  deepgram: 'Deepgram',
  whisper: 'Whisper',
}

const STORAGE_KEY = 'jarvis.transcriber'
const DEEPGRAM_KEY = 'jarvis.deepgramKey'

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

// The Deepgram key lives in phone storage, like the AI keys; never bundled.
export async function getDeepgramKey(): Promise<string | null> {
  try {
    return (await bridge.getLocalStorage(DEEPGRAM_KEY)) || null
  } catch {
    return null
  }
}

export async function setDeepgramKey(key: string): Promise<boolean> {
  const ok = await bridge.setLocalStorage(DEEPGRAM_KEY, key.trim())
  if (!ok) status('Failed to save the Deepgram key')
  return ok
}
