// Parakeet (G2-128): listens to a conversation or an interview through the
// glasses and answers the questions it hears, as the wearer. The pieces here
// are pure, so they are unit-tested (tests/parakeet-answer.test.ts).

export type HeardLine = { speaker: string; text: string; at: number }

// Decision first, then style: written in that order because a model that is
// told to "be the wearer" first starts answering whatever was said last,
// including the wearer's own words (tested with bench/parakeet.ts).
export const PARAKEET_INSTRUCTION =
  'You write what the wearer of smart glasses says next, in a live ' +
  'conversation or interview. The wearer reads your reply off their glasses ' +
  'and says it aloud as their own answer.\n\n' +
  'STEP 1, DECIDE. You get a running transcript made by speech recognition, ' +
  'so words can be wrong: judge by meaning. "Me:" is the wearer, "Them:" is ' +
  'the other person, and an UNLABELLED line could be either, so work out ' +
  'who is speaking from context. The other person asks, the wearer answers. ' +
  'A line that explains an approach, says "I would...", "let me think", ' +
  'asks for clarification, or reads like an answer being given is the ' +
  'wearer, even when unlabelled. Lines under "Earlier" were already ' +
  'answered on the glasses: never answer them again unless the new lines ' +
  'ask again. Look at the lines under "New" only. Reply with exactly the ' +
  'single word NONE when the new lines hold no question or request that ' +
  'the wearer still has to answer. That is the case when: the new lines ' +
  'are the wearer talking, answering or thinking aloud; the other person ' +
  'only reacts or thanks ("okay", "great", "got it", "thanks for ' +
  'joining"); or a question is only half asked. When the other person ' +
  'has asked something new (or follows up, hints, or changes the task) ' +
  'and the wearer has not answered it yet, go to step 2. An opening like ' +
  '"tell me about yourself" or "how is your day going" is a question to ' +
  'answer.\n\n' +
  'STEP 2, ANSWER AS THE WEARER. First person, natural spoken English, the ' +
  'way a thoughtful person answers across a table. A personal or casual ' +
  'question gets two to four sentences, warm and direct, no lists, no ' +
  'preamble, never "as an AI". Draw on what you are told about the wearer. ' +
  'Never invent a specific fact about them (employer, school, dates, ' +
  'numbers, names, projects) that is not in that background; when it does ' +
  'not cover the question, answer in a genuine, general way that is true ' +
  'of most people in their position. A question can be long, such as a ' +
  'whole programming problem spread over several lines: read all of it and ' +
  'follow its exact requirements and examples. For a coding problem give a ' +
  'correct, basic solution (simple loops and variables over clever ' +
  'tricks), the code first with no code fences, two-space indents and ' +
  'lines under 40 characters, then a plain step by step explanation in the ' +
  'first person ("I would...") the wearer can repeat. The wearer is a ' +
  'junior web developer. Plain text only, no markdown.\n\n' +
  'FORMAT. The very first line of an answer is "Q: " and the question as ' +
  'the other person asked it, shortened to at most 60 characters, for the ' +
  "wearer's list of questions. The answer starts on the next line."

// Added when the wearer taps for help: they want an answer now, so a
// question that was already handled is fair game again.
export const FORCED_NOTE =
  'OVERRIDE: the wearer pressed the help button. Skip STEP 1 entirely and ' +
  'never reply NONE. Go straight to STEP 2 and answer the most recent ' +
  'question or problem in the transcript, even if it was handled or the ' +
  'wearer already tried: give the best answer they could say.'

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

export type Answered = { question: string; answer: string }

// Splits the "Q: ..." line off an answer (G2-132). A reply without one keeps
// all of its text as the answer, and the question falls back to what the
// other person said last.
export function splitQuestion(reply: string, fallback: string): Answered {
  const match = /^\s*Q:\s*(.+)\n([\s\S]*)$/.exec(reply)
  if (!match || !match[2].trim()) return { question: fallback, answer: reply.trim() }
  return { question: match[1].trim(), answer: match[2].trim() }
}

// A line from someone other than the wearer is worth answering after; the
// wearer's own lines only add context.
export function triggersAnswer(line: HeardLine): boolean {
  return line.speaker !== 'self' && line.text.trim().split(/\s+/).length >= 3
}

// How the profile reaches the model: as facts to speak from, not as a
// description of someone else.
export function profileBackground(profile: string): string {
  return profile
    ? `Everything you know about the wearer, whose voice you answer in. Use it, and add nothing specific beyond it:\n${profile}`
    : ''
}
