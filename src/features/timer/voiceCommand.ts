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

// Matched by edit distance, not an exact word list - Whisper mishears
// "timer" as "dimer", "thymer", "timmer" and no doubt others depending on
// the wearer's accent and the mic's own noise floor, and a fixed list of
// known mishearings is an endless game of whack-a-mole. Edit distance
// catches the pattern (an acoustic near-miss) instead of each individual
// case. Safe to be a little loose here: a keyword near-match alone does
// nothing - parseVoiceCommand below still requires an actual number+unit
// duration in the same transcript before it commits to starting anything,
// so a false-positive keyword match on an unrelated word just falls through
// to "unrecognized" rather than triggering a wrong action.
const KEYWORDS = ['timer', 'alarm']
const MAX_KEYWORD_DISTANCE = 2
// Below this length, edit distance 2 is close to meaningless (most common
// short words would be within reach of "timer" or "alarm" by chance) - most
// concretely, "time" is only one edit from "timer" ("the time is 5 minutes
// past noon" is not a timer command), so the floor sits above it rather
// than at the more obvious-looking 4.
const MIN_FUZZY_WORD_LENGTH = 5

function levenshtein(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  const dist: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
  for (let i = 0; i < rows; i++) dist[i][0] = i
  for (let j = 0; j < cols; j++) dist[0][j] = j
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dist[i][j] = Math.min(dist[i - 1][j] + 1, dist[i][j - 1] + 1, dist[i - 1][j - 1] + cost)
    }
  }
  return dist[a.length][b.length]
}

function hasTimerKeyword(text: string): boolean {
  const words = text.match(/[a-z]+/g) ?? []
  return words.some(
    word =>
      word.length >= MIN_FUZZY_WORD_LENGTH &&
      KEYWORDS.some(keyword => levenshtein(word, keyword) <= MAX_KEYWORD_DISTANCE),
  )
}

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
  if (!hasTimerKeyword(text)) return { kind: 'unrecognized', transcript }
  const durationMs = parseDurationMs(text)
  if (durationMs <= 0) return { kind: 'unrecognized', transcript }
  return { kind: 'startTimer', durationMs }
}
