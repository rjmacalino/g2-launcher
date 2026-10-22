import { isSpeech, nextFloor, type EndpointDecision } from './endpoint'

// When has the wearer finished their question (G2-149)? A fixed silence
// timeout is either rude or slow: short, and it cuts off someone who pauses
// to think; long, and every answer waits. So, like the semantic end-of-turn
// detection modern voice assistants pair with silence, the pause allowed
// depends on what has been said: a short one when the live transcript reads
// finished ("...in JavaScript?"), a long one when it trails off ("...and
// the", "so um"). Without a live transcript (Whisper), always the long one.
// Pure: fed one loudness value per mic event, plus the transcript so far.

export type TurnOptions = {
  // The quiet floor to start from (the audio just before recording).
  initialFloor?: number
  // The wearer was already talking when recording started.
  alreadySpeaking?: boolean
  frameMs?: number
  completePauseMs?: number
  incompletePauseMs?: number
  // No speech at all for this long means they are not going to speak.
  noSpeechMs?: number
}

export const COMPLETE_PAUSE_MS = 1500
export const INCOMPLETE_PAUSE_MS = 4000

const MIN_SPEECH_FRAMES = 3

// Words a sentence does not end on: it is still going.
const CONTINUATIONS = new Set(
  [
    'and or but so because cause if then than when while where which who',
    'whose that the a an to of in on at for with from by about into is are',
    'was were be my your their our its like um uh erm hmm also plus how what',
    'why whether as not very really just',
  ]
    .join(' ')
    .split(' '),
)

// Whether the words so far read as a finished question or sentence: end
// punctuation (Gemini Live punctuates) on a word that does not continue.
export function soundsFinished(transcript: string): boolean {
  const text = transcript.trim()
  if (!/[.?!]["')\]]*$/.test(text)) return false
  const words = text.toLowerCase().match(/[a-z']+/g)
  if (!words || words.length === 0) return false
  return !CONTINUATIONS.has(words[words.length - 1])
}

export function createTurnDetector({
  initialFloor,
  alreadySpeaking = false,
  frameMs = 100,
  completePauseMs = COMPLETE_PAUSE_MS,
  incompletePauseMs = INCOMPLETE_PAUSE_MS,
  noSpeechMs = 6000,
}: TurnOptions = {}) {
  let floor = initialFloor ?? Infinity
  let elapsed = 0
  let speechFrames = 0
  let heardSpeech = alreadySpeaking
  let quietMs = 0
  let loudest = 0
  let lastTranscript = ''
  return {
    // transcript: the live words so far, or null when there is no live
    // transcription (the long pause is used then).
    push(rms: number, transcript: string | null = null): EndpointDecision {
      elapsed += frameMs
      loudest = Math.max(loudest, rms)
      const loud = isSpeech(rms, floor)
      floor = nextFloor(rms, floor, loud)
      if (loud) {
        speechFrames += 1
        quietMs = 0
        if (speechFrames >= MIN_SPEECH_FRAMES) heardSpeech = true
      } else {
        speechFrames = 0
        quietMs += frameMs
      }
      // New words are speech too, even when the mic level missed them.
      if (transcript !== null && transcript.trim() !== lastTranscript) {
        lastTranscript = transcript.trim()
        if (lastTranscript) {
          heardSpeech = true
          quietMs = 0
        }
      }
      const pause =
        transcript !== null && soundsFinished(transcript) ? completePauseMs : incompletePauseMs
      if (heardSpeech && quietMs >= pause) return 'finished'
      if (!heardSpeech && elapsed >= noSpeechMs) return 'no-speech'
      return 'listening'
    },
    heardSpeech: () => heardSpeech,
    floor: () => floor,
    loudest: () => loudest,
  }
}
