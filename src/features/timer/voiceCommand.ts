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
  | { kind: 'startTimer'; durationMs: number }
  | { kind: 'cancelTimer' }
  | { kind: 'pauseTimer' }
  | { kind: 'resumeTimer' }
  | { kind: 'timerStatus' }
  | { kind: 'unrecognized'; transcript: string }

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

// Real, common English words within the fuzzy distance of "timer" or
// "alarm", which must never count as the keyword. This matters far more
// since Jarvis merged with the Gemini conversation tool: every question now
// passes through here first, not just deliberate commands, so "how many
// times a day should I stretch for 10 minutes?" would otherwise start a
// 10-minute timer instead of being answered.
const NOT_KEYWORDS = new Set([
  'times',
  'timed',
  'timber',
  'tiger',
  'tamer',
  'tuner',
  'toner',
  'taker',
  'liner',
  'miner',
  'diner',
  'alarmed',
  'alarming',
])

function hasTimerKeyword(text: string): boolean {
  const words = text.match(/[a-z]+/g) ?? []
  return words.some(
    word =>
      word.length >= MIN_FUZZY_WORD_LENGTH &&
      !NOT_KEYWORDS.has(word) &&
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
  const control = parseControl(text)
  if (control) return control
  const durationMs = parseDurationMs(text)
  if (durationMs <= 0) return { kind: 'unrecognized', transcript }
  return { kind: 'startTimer', durationMs }
}

// Controlling the timer that is already running. Short commands only:
// "cancel the timer", "pause my timer please", "how much time is left on
// the timer". Anything longer goes to Gemini, which can still call the same
// action (features/timer/actions.ts) when that is what was meant - a long
// sentence that merely contains "timer" and "stop" ("how do I stop the
// timer app on my phone from beeping") is much more likely a question.
const MAX_CONTROL_WORDS = 8

const CANCEL_WORDS = /\b(cancel|stop|clear|delete|kill)\b|\bturn off\b/
const PAUSE_WORDS = /\b(pause|hold)\b/
const RESUME_WORDS = /\b(resume|unpause|continue)\b/
const STATUS_WORDS = /\b(left|remaining|how much|how long|check|status)\b/

// Checked before the duration: "cancel the 5 minute timer" contains a
// duration too, and must never start a new 5-minute timer. The other
// controls only count without a duration - "set a timer for 5 minutes and
// check on the oven" is a start.
function parseControl(text: string): VoiceCommand | null {
  const words = text.match(/[a-z0-9']+/g) ?? []
  if (words.length > MAX_CONTROL_WORDS) return null
  if (CANCEL_WORDS.test(text)) return { kind: 'cancelTimer' }
  if (parseDurationMs(text) > 0) return null
  if (PAUSE_WORDS.test(text)) return { kind: 'pauseTimer' }
  if (RESUME_WORDS.test(text)) return { kind: 'resumeTimer' }
  if (STATUS_WORDS.test(text)) return { kind: 'timerStatus' }
  return null
}
