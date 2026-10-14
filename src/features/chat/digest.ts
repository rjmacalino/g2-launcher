import type { ChatSession } from './store'

// A short digest of the wearer's OTHER recent conversations, sent along with
// every Gemini chat question so it can draw on them - per direct request
// ("is it possible to use other chats for context?"). Each conversation on
// its own is still sent in full; this only adds a bounded summary of the
// rest, so the request does not grow with the whole history.
//
// Lossy on purpose: the title (the conversation's first question), the last
// thing asked and the start of Gemini's last answer. Enough for "the trip I
// asked you about yesterday" to land; not every detail.
//
// Pure - no I/O - so tests/chat-digest.test.ts can check its limits.

export const DIGEST_MAX_SESSIONS = 5
export const DIGEST_MAX_CHARS = 2000
const QUESTION_MAX_CHARS = 120
const ANSWER_MAX_CHARS = 200

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat
}

// YYYY-MM-DD in the phone's own time zone, so "yesterday" means what the
// wearer means by it.
function localDate(ms: number): string {
  const d = new Date(ms)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

function summarize(session: ChatSession): string {
  const lastQuestion = [...session.messages].reverse().find(m => m.role === 'user')
  const lastAnswer = [...session.messages].reverse().find(m => m.role === 'model')
  let line = `- ${localDate(session.updatedAt)}, "${clip(session.title, QUESTION_MAX_CHARS)}"`
  if (lastQuestion && lastQuestion.text.trim() !== session.title.trim()) {
    line += `; last asked: "${clip(lastQuestion.text, QUESTION_MAX_CHARS)}"`
  }
  if (lastAnswer) line += `; you answered: "${clip(lastAnswer.text, ANSWER_MAX_CHARS)}"`
  return line
}

// Empty string when there is nothing to add. currentSessionId is left out -
// that conversation is already sent in full.
export function buildDigest(
  sessions: readonly ChatSession[],
  currentSessionId: string | null,
  now: number = Date.now(),
): string {
  const others = [...sessions]
    .filter(s => s.id !== currentSessionId && s.messages.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, DIGEST_MAX_SESSIONS)
  if (others.length === 0) return ''

  let digest =
    `Today is ${localDate(now)}. For context only, the person's other recent ` +
    'conversations with you, newest first. Use them if they are relevant to ' +
    'what is being asked now; do not bring them up otherwise:'
  let added = 0
  for (const session of others) {
    const line = `\n${summarize(session)}`
    if (digest.length + line.length > DIGEST_MAX_CHARS) break
    digest += line
    added++
  }
  return added > 0 ? digest : ''
}
