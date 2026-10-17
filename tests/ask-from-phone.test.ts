import { beforeEach, describe, expect, it, vi } from 'vitest'

// The phone's ask path end to end, with the phone storage and the AI faked:
// storage is an in-memory map, the AI echoes the question.
const storage = new Map<string, string>()

vi.mock('../src/platform/bridge', () => ({
  status: vi.fn(),
  bridge: {
    getLocalStorage: vi.fn(async (key: string) => storage.get(key) ?? ''),
    setLocalStorage: vi.fn(async (key: string, value: string) => {
      storage.set(key, value)
      return true
    }),
  },
}))

vi.mock('../src/core/llm', () => ({
  askModel: vi.fn(async (_config: unknown, turns: { text: string }[]) => ({
    kind: 'answer',
    text: `Answer to: ${turns[turns.length - 1].text}`,
  })),
  describeModel: () => 'fake',
}))

beforeEach(() => {
  storage.clear()
  vi.resetModules()
})

async function load() {
  const { registerVoiceDispatch } = await import('../src/core/voiceDispatch')
  registerVoiceDispatch(async text =>
    /timer/i.test(text) ? { handled: true, message: 'Started a 5:00 timer.' } : { handled: false },
  )
  const { askFromPhone } = await import('../src/features/chat/assistant')
  const { chatSessions } = await import('../src/features/chat/store')
  return { askFromPhone, chatSessions }
}

describe('askFromPhone', () => {
  it('reports a missing key instead of failing', async () => {
    const { askFromPhone } = await load()
    expect(await askFromPhone('What is the capital of Australia?', null)).toEqual({
      kind: 'no-key',
    })
  })

  it('starts a conversation, saves the question and the answer', async () => {
    storage.set('jarvis.geminiApiKey', 'k')
    const { askFromPhone, chatSessions } = await load()
    const changes = vi.fn()
    chatSessions.onChange(changes)
    const result = await askFromPhone('What is the capital of Australia?', null)
    expect(result.kind).toBe('answered')
    const saved = await chatSessions.readAll()
    expect(saved).toHaveLength(1)
    expect(saved[0].messages.map(m => m.text)).toEqual([
      'What is the capital of Australia?',
      'Answer to: What is the capital of Australia?',
    ])
    // Question saved first, then the answer: the glasses can show each.
    expect(changes).toHaveBeenCalledTimes(2)
  })

  it('continues an existing conversation', async () => {
    storage.set('jarvis.geminiApiKey', 'k')
    const { askFromPhone, chatSessions } = await load()
    const first = await askFromPhone('First question', null)
    if (first.kind !== 'answered') throw new Error('expected an answer')
    await askFromPhone('Follow up', first.session.id)
    const saved = await chatSessions.readAll()
    expect(saved).toHaveLength(1)
    expect(saved[0].messages).toHaveLength(4)
  })

  it('runs a timer command locally, without the AI or a key', async () => {
    const { askFromPhone, chatSessions } = await load()
    const result = await askFromPhone('set a timer for 5 minutes', null)
    expect(result).toEqual({ kind: 'command', reply: 'Started a 5:00 timer.', session: null })
    expect(await chatSessions.readAll()).toHaveLength(0)
  })
})
