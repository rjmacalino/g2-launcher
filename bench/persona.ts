import { buildDigest } from '../src/features/chat/digest'
import type { ChatSession } from '../src/features/chat/store'

// A made-up wearer for the "personal" questions, so the benchmark never
// needs anyone's real About You text or conversation history. ABOUT_ME
// goes where the companion page's About You text goes; the past sessions
// go through the real buildDigest, the same digest Jarvis sends on the
// glasses, so "what was my budget for the laptop?" is answered from the
// same kind of memory it would be in real use.
export const ABOUT_ME =
  "I'm Sam, a product manager at a fintech startup in Sydney. I'm vegetarian. " +
  "I'm training for a half marathon in March. My partner is Jordan."

const DAY_MS = 24 * 60 * 60 * 1000

function session(id: string, daysAgo: number, question: string, answer: string): ChatSession {
  const at = Date.now() - daysAgo * DAY_MS
  return {
    id,
    title: question,
    updatedAt: at,
    messages: [
      { role: 'user', text: question, timestamp: at },
      { role: 'model', text: answer, timestamp: at + 1000 },
    ],
  }
}

const PAST_SESSIONS: ChatSession[] = [
  session(
    'laptop',
    2,
    'I need a new laptop for work, my budget is 2000 dollars. Mac or Windows?',
    'With 2000 dollars you can get a MacBook Air with 16GB of memory or a well specced Windows ultrabook.',
  ),
  session(
    'dinner',
    5,
    'Give me a quick vegetarian dinner idea',
    'A chickpea curry with spinach and rice takes about twenty minutes.',
  ),
]

export function background(): string {
  return buildDigest(PAST_SESSIONS, null)
}
