// Parakeet (G2-128): listens to a conversation or an interview through the
// glasses and shows an answer to the question it just heard. The pieces here
// are pure, so they are unit-tested (tests/parakeet-answer.test.ts).

export type HeardLine = { speaker: string; text: string; at: number }

export const PARAKEET_INSTRUCTION =
  'You are Jarvis, helping the person wearing smart glasses during a live ' +
  'conversation or interview. You get a running transcript made by speech ' +
  'recognition, so words can be wrong: judge by meaning. "Me:" is the ' +
  'wearer, "Them:" is the other person, and an UNLABELLED line could be ' +
  'either, so work out who is speaking from context. The wearer is the one ' +
  'being asked: an interviewer or other person asks, and the wearer ' +
  'answers. Lines that explain an approach, say "I would...", "let me ' +
  'think", ask for clarification, or read like an answer being given are the ' +
  'wearer talking, even when unlabelled, and are NEVER a question for you ' +
  'to answer. Lines under "Earlier" are context that was already handled. ' +
  'Only the lines under "New" can hold something to answer. Reply with ' +
  'exactly NONE when the new lines hold no fresh question, problem, or ' +
  'request put to the wearer: small talk, the wearer speaking, thinking ' +
  'aloud or answering, a question that is only half asked so far, or an ' +
  'acknowledgement like "okay" or "got it". When a question or problem ' +
  'is there (it can be long, such as a whole programming problem spread ' +
  'over several lines, or a follow-up or a hint that changes the task), ' +
  'read all of it, follow its exact requirements and examples, and answer ' +
  'it so the wearer can say the answer out loud. For a coding problem give ' +
  'a correct, basic solution, simple loops and variables over clever ' +
  'tricks, the code first with no code fences, two-space indents and lines ' +
  'under 40 characters, then a plain step by step explanation the wearer ' +
  'can repeat. The wearer is a junior web developer. For any other ' +
  'question give a short structured answer. Plain text only, no markdown.'

// Added when the wearer taps for help: they want an answer now, so a
// question that was already handled is fair game again.
export const FORCED_NOTE =
  'The wearer has asked for help right now: if the new lines hold nothing, ' +
  'answer the most recent question or problem in the transcript instead of ' +
  'replying NONE.'

// About ten minutes of talk: a long problem read aloud stays whole.
const TRANSCRIPT_CHARS = 6000

function label(speaker: string): string {
  if (speaker === 'self') return 'Me: '
  if (speaker === 'other') return 'Them: '
  return ''
}

// The newest lines that fit, oldest first, one per line, with the ones
// already handled (the first `handled` lines of `lines`) set apart from the
// new ones so a question is not answered twice.
export function transcriptFor(lines: readonly HeardLine[], handled = 0): string {
  const shown: string[] = []
  let chars = 0
  let first = lines.length
  for (let i = lines.length - 1; i >= 0 && chars < TRANSCRIPT_CHARS; i--) {
    const line = `${label(lines[i].speaker)}${lines[i].text}`
    shown.unshift(line)
    chars += line.length + 1
    first = i
  }
  const cut = Math.min(Math.max(handled - first, 0), shown.length)
  const old = shown.slice(0, cut)
  const fresh = shown.slice(cut)
  const join = (rows: string[]) => rows.join('\n')
  if (old.length === 0) return join(fresh)
  return `Earlier:\n${join(old)}\n\nNew:\n${join(fresh) || '(nothing new)'}`
}

// The answer to show, or null when the model found nothing to answer.
export function parseAnswer(reply: string): string | null {
  const text = reply.trim()
  if (text === '' || /^none\.?$/i.test(text)) return null
  return text
}

// A line from someone other than the wearer is worth answering after; the
// wearer's own lines only add context.
export function triggersAnswer(line: HeardLine): boolean {
  return line.speaker !== 'self' && line.text.trim().split(/\s+/).length >= 3
}
