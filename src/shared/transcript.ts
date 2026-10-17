// Cleaning what Whisper returns into what was actually said. Pure, shared
// by core/voiceCapture.ts (one recording) and Lab's live transcription
// probe (one chunk at a time, where the same "You" shows up every few
// seconds of room noise).

// Whisper marks non-speech in brackets or parentheses - "[BLANK_AUDIO]",
// "(upbeat music)", "[Music]" - which are not anything the wearer said.
export function stripNonSpeech(transcript: string): string {
  return transcript
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// What Whisper is known to invent from near-silence rather than return
// nothing: faint room noise in the simulator came back as "You" and was
// sent to Gemini as a question, then saved as a conversation titled "You".
// Only whole transcripts that are never a real question on their own -
// "thank you" is left alone, since someone might actually say it.
const SILENCE_HALLUCINATIONS = new Set([
  'you',
  'thanks for watching',
  'thank you for watching',
  'thanks for watching bye',
  'please subscribe',
])

export function isSilenceHallucination(transcript: string): boolean {
  const words = transcript
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return SILENCE_HALLUCINATIONS.has(words)
}
