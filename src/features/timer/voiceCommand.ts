// Turns a speech-to-text transcript into a timer duration. Pure text
// processing, no SDK access and no opinion on WHERE the transcript came from
// - deliberately so, since which speech engine actually produces it (browser
// SpeechRecognition vs Whisper) is still an open question (see
// docs/roadmap.md decision D1). Whichever wins, it hands this function a
// plain string.
//
// Numbers only ("5 minutes"), not number words ("five minutes"). Speech
// engines commonly normalise small spoken numbers to digits already, and
// spelling out every English number word is scope this does not need yet -
// easy to add later if a real transcript comes back unparsed because of it.
export type VoiceCommand =
  { kind: 'startTimer'; durationMs: number } | { kind: 'unrecognized'; transcript: string }

const TIMER_KEYWORD = /\b(?:timer|alarm)\b/

const DURATION_UNIT_MS: Record<string, number> = {
  hour: 3_600_000,
  hours: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  minute: 60_000,
  minutes: 60_000,
  min: 60_000,
  mins: 60_000,
  second: 1_000,
  seconds: 1_000,
  sec: 1_000,
  secs: 1_000,
}

const DURATION_PART = /(\d+)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/g

// Sums every number+unit pair found anywhere in the phrase, rather than
// requiring one fixed order, so "1 hour 30 minutes" and "30 minutes 1 hour"
// both work - a transcript's word order is not something this can rely on.
function parseDurationMs(phrase: string): number {
  let totalMs = 0
  for (const match of phrase.matchAll(DURATION_PART)) {
    const amount = Number(match[1])
    const unitMs = DURATION_UNIT_MS[match[2]]
    totalMs += amount * unitMs
  }
  return totalMs
}

// "Jarvis, timer 5 minutes", "set a timer for 5 minutes", "alarm 5 minutes"
// all parse the same way: find the keyword, then pull every duration part out
// of the whole transcript. Filler words (Jarvis, set, a, for, and, please)
// are never matched by either regex, so they are ignored by omission rather
// than needing their own list to strip.
export function parseVoiceCommand(transcript: string): VoiceCommand {
  const text = transcript.toLowerCase().trim()
  if (!TIMER_KEYWORD.test(text)) return { kind: 'unrecognized', transcript }
  const durationMs = parseDurationMs(text)
  if (durationMs <= 0) return { kind: 'unrecognized', transcript }
  return { kind: 'startTimer', durationMs }
}
