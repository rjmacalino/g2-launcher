// Wingman's cues (G2-66): what to ask Gemini, how to read its reply,
// and when to ask. Pure, so all three are unit-tested
// (tests/live-cues.test.ts) and measured by bench/cues.ts.
//
// Aimed at the two things RJ found wrong with the native Conversate: cues
// that are trivia, and cues that arrive late. So the model is told to say
// nothing unless a cue would actually help this wearer right now, cues are
// one short line, and a question asked of the wearer triggers one at once
// instead of waiting for the next timed check.

export type CueLine = { speaker: string; text: string; at: number }

export const CUE_INSTRUCTION =
  'You are Jarvis, silently helping the person wearing smart glasses during ' +
  'a live, in-person conversation. You see a running transcript; "You:" is ' +
  'the wearer, "Them:" is the other person, unlabelled lines could be ' +
  'either. Your reply is flashed on a tiny display for a few seconds while ' +
  'they keep talking, so reply with ONE cue of at most 12 words, or with ' +
  'exactly NONE when nothing would genuinely help right now - NONE is the ' +
  'usual answer. A good cue is what the wearer needs in this moment: the ' +
  'answer to a question they were just asked, the key point for a ' +
  'technical question, a relevant fact about them or their plans from ' +
  'their background, or a natural follow-up question when the conversation ' +
  'stalls. Never trivia, never fun facts, never restating what was said, ' +
  'never generic advice like "listen actively". Plain text only, no ' +
  'quotes, no "Cue:" label.'

// Cues are a dozen words, but a 60-token cap cut real replies off
// mid-word ("Around 2", "Windows ultr" from Gemini 3.8 Flash in
// bench/cues.ts). Length is held by the instruction and by parseCue's
// clip, not by this ceiling.
export const CUE_MAX_TOKENS = 200

// About two minutes of conversation - enough for context, small enough to
// keep each request fast and cheap.
const TRANSCRIPT_CHARS = 1500

function label(speaker: string): string {
  if (speaker === 'self') return 'You: '
  if (speaker === 'other') return 'Them: '
  return ''
}

// The transcript Gemini sees: the newest lines that fit, oldest first.
export function transcriptForCue(lines: readonly CueLine[]): string {
  const kept: string[] = []
  let chars = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = `${label(lines[i].speaker)}${lines[i].text}`
    if (chars + line.length > TRANSCRIPT_CHARS && kept.length > 0) break
    kept.unshift(line)
    chars += line.length + 1
  }
  return `Conversation so far (newest last):\n${kept.join('\n')}`
}

const MAX_CUE_CHARS = 90

// The cue to show, or null for "nothing to say". Tolerates the usual ways
// a model wraps a one-liner: quotes, a "Cue:" label, a trailing NONE
// explanation ("NONE - nothing needed").
export function parseCue(reply: string): string | null {
  let text = reply.trim().replace(/\s+/g, ' ')
  text = text.replace(/^(cue|jarvis)\s*:\s*/i, '')
  text = text.replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, '').trim()
  if (!text || /^none\b/i.test(text) || /^n\/a$/i.test(text)) return null
  if (text.length > MAX_CUE_CHARS) text = `${text.slice(0, MAX_CUE_CHARS - 3).trimEnd()}...`
  return text
}

export type CuePolicyOptions = {
  // Never two requests closer than this - the free tier's per-minute limit.
  minGapMs?: number
  // Without a question or a tap, ask at most this often...
  idleGapMs?: number
  // ...and only once this much new conversation has been transcribed.
  minNewChars?: number
}

// Decides when Wingman asks for a cue. One request at a time; a reason
// to ask that comes up while one is in flight is remembered and acted on
// as soon as it finishes, so a question asked mid-request is not lost.
export function createCuePolicy({
  minGapMs = 6000,
  idleGapMs = 15_000,
  minNewChars = 60,
}: CuePolicyOptions = {}) {
  let lastAskAt = -Infinity
  let inFlight = false
  let newChars = 0
  let urgent = false

  function due(now: number): boolean {
    if (inFlight || now - lastAskAt < minGapMs) return false
    if (urgent) return true
    return now - lastAskAt >= idleGapMs && newChars >= minNewChars
  }

  return {
    // A new transcript line. Returns true when a cue should be asked for now.
    onLine(text: string, now: number): boolean {
      newChars += text.length
      if (text.trim().endsWith('?')) urgent = true
      return due(now)
    },
    // The wearer tapped for a cue.
    onTap(now: number): boolean {
      urgent = true
      return due(now)
    },
    // Checked on a timer, so an urgent ask held back by minGapMs still
    // goes out once the gap has passed.
    onTick(now: number): boolean {
      return due(now)
    },
    started(now: number): void {
      inFlight = true
      lastAskAt = now
      newChars = 0
      urgent = false
    },
    finished(): void {
      inFlight = false
    },
  }
}
