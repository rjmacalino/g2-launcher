import { beforeEach, describe, expect, it } from 'vitest'
import { chat, chatAsSession, clearChat, loadChat } from '../src/features/chat/currentChat'

// The chat on screen (G2-176).

beforeEach(() => clearChat())

describe('currentChat', () => {
  it('a new chat has no session to save until its first question', () => {
    clearChat('coding', 'Python')
    expect(chat).toMatchObject({ id: null, messages: [], mode: 'coding', language: 'Python' })
    expect(chatAsSession()).toBeNull()
  })

  it('loads a saved session with its mode and language, unknown modes as Auto', () => {
    loadChat({
      id: 's1',
      title: 'Two sum',
      messages: [{ role: 'user', text: 'Two sum', timestamp: 1 }],
      updatedAt: 1,
      mode: 'coding',
      language: 'C#',
    })
    expect(chat).toMatchObject({ id: 's1', title: 'Two sum', mode: 'coding', language: 'C#' })
    loadChat({ id: 's2', title: 'x', messages: [], updatedAt: 1, mode: 'no-such-mode' })
    expect(chat.mode).toBe('auto')
    expect(chat.language).toBeNull()
  })

  it('saves as a session stamped now, with a title even if it has none', () => {
    loadChat({ id: 's1', title: 'Two sum', messages: [], updatedAt: 1 })
    chat.title = null
    expect(chatAsSession(42)).toEqual({
      id: 's1',
      title: '(untitled)',
      messages: [],
      updatedAt: 42,
    })
  })
})
