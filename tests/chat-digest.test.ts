import { describe, expect, it } from 'vitest'
import { buildDigest, DIGEST_MAX_CHARS, DIGEST_MAX_SESSIONS } from '../src/features/chat/digest'
import type { ChatSession } from '../src/features/chat/store'

function session(id: string, updatedAt: number, question: string, answer?: string): ChatSession {
  const messages: ChatSession['messages'] = [{ role: 'user', text: question, timestamp: updatedAt }]
  if (answer) messages.push({ role: 'model', text: answer, timestamp: updatedAt })
  return { id, title: question, messages, updatedAt }
}

const NOW = new Date(2026, 9, 15, 12).getTime()
const DAY = 24 * 60 * 60 * 1000

describe('buildDigest', () => {
  it('is empty when there are no other conversations', () => {
    expect(buildDigest([], null, NOW)).toBe('')
    expect(buildDigest([session('a', NOW, 'hi', 'hello')], 'a', NOW)).toBe('')
  })

  it('leaves out the conversation currently being asked in', () => {
    const digest = buildDigest(
      [
        session('current', NOW, 'current question', 'x'),
        session('other', NOW - DAY, 'other topic', 'y'),
      ],
      'current',
      NOW,
    )
    expect(digest).toContain('other topic')
    expect(digest).not.toContain('current question')
  })

  it('lists the most recent conversations first, at most five', () => {
    const sessions = Array.from({ length: 8 }, (_, i) =>
      session(`s${i}`, NOW - i * DAY, `topic number ${i}`, `answer ${i}`),
    )
    const digest = buildDigest(sessions, null, NOW)
    for (let i = 0; i < DIGEST_MAX_SESSIONS; i++) expect(digest).toContain(`topic number ${i}`)
    expect(digest).not.toContain('topic number 5')
    expect(digest.indexOf('topic number 0')).toBeLessThan(digest.indexOf('topic number 1'))
  })

  it('dates each conversation and states today, so "yesterday" means something', () => {
    const digest = buildDigest([session('a', NOW - DAY, 'trip plans', 'go in spring')], null, NOW)
    expect(digest).toContain('Today is 2026-10-15')
    expect(digest).toContain('2026-10-14')
  })

  it('stays under the size limit however long the conversations are', () => {
    const long = 'word '.repeat(2000)
    const sessions = Array.from({ length: 5 }, (_, i) => session(`s${i}`, NOW - i, long, long))
    expect(buildDigest(sessions, null, NOW).length).toBeLessThanOrEqual(DIGEST_MAX_CHARS)
  })

  it('includes the last question and the start of the last answer', () => {
    const s = session('a', NOW, 'first question', 'first answer')
    s.messages.push(
      { role: 'user', text: 'follow-up question', timestamp: NOW },
      { role: 'model', text: 'latest answer text', timestamp: NOW },
    )
    const digest = buildDigest([s], null, NOW)
    expect(digest).toContain('first question')
    expect(digest).toContain('follow-up question')
    expect(digest).toContain('latest answer text')
  })
})
