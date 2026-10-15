import { beforeEach, describe, expect, it, vi } from 'vitest'

// A fake of the host's storage bridge. `hold` lets a test keep a read
// unanswered, the way the real host sometimes does (see
// features/chat/store.ts), and release it later.
const stored = new Map<string, string>()
let hold: Promise<void> | null = null

vi.mock('../src/platform/bridge', () => ({
  bridge: {
    getLocalStorage: async (key: string) => {
      if (hold) await hold
      return stored.get(key) ?? ''
    },
    setLocalStorage: async (key: string, value: string) => {
      stored.set(key, value)
      return true
    },
  },
  status: vi.fn(),
}))

type Store = typeof import('../src/features/chat/store')

// The store keeps its cache in module state, so each test gets a fresh copy.
async function freshStore(): Promise<Store['chatSessions']> {
  vi.resetModules()
  return (await import('../src/features/chat/store')).chatSessions
}

function message(role: 'user' | 'model', text: string) {
  return { role, text, timestamp: 1 }
}

// Lets queued background writes run.
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  stored.clear()
  hold = null
})

describe('chatSessions', () => {
  it('peek is null until the startup load finishes, then has the saved chats', async () => {
    stored.set(
      'chat.sessions',
      JSON.stringify([{ id: 'a', title: 'A', messages: [], updatedAt: 1 }]),
    )
    const store = await freshStore()
    expect(store.peek()).toBeNull()
    await store.readAll()
    expect(store.peek()?.map(s => s.id)).toEqual(['a'])
  })

  it('writes only ASCII, and reads non-ASCII text back unchanged', async () => {
    const store = await freshStore()
    const text = `It${String.fromCharCode(0x2019)}s ${String.fromCharCode(0x2014)} fine ${String.fromCodePoint(0x1f600)}`
    const session = store.newSession(message('user', text))
    await store.save(session)
    await settle()
    const raw = stored.get('chat.sessions') ?? ''
    expect([...raw].every(c => c.charCodeAt(0) < 0x7f)).toBe(true)
    const reread = await freshStore()
    expect((await reread.readAll())[0].messages[0].text).toBe(text)
  })

  it('rewrites old non-ASCII data in ASCII-safe form the first time it loads', async () => {
    const curly = String.fromCharCode(0x2019)
    stored.set(
      'chat.sessions',
      JSON.stringify([{ id: 'a', title: `it${curly}s`, messages: [], updatedAt: 1 }]),
    )
    const store = await freshStore()
    await store.readAll()
    await settle()
    expect(stored.get('chat.sessions')).not.toContain(curly)
    expect(stored.get('chat.sessions')).toContain('\\u2019')
  })

  it('a save made while the load is still unanswered never overwrites saved history', async () => {
    stored.set(
      'chat.sessions',
      JSON.stringify([{ id: 'old', title: 'Old', messages: [], updatedAt: 1 }]),
    )
    let release!: () => void
    hold = new Promise(resolve => (release = resolve))
    const store = await freshStore()
    store.preload()
    void store.save(store.newSession(message('user', 'new question')))
    await settle()
    // Still waiting on the host: nothing written yet, old history intact.
    expect(JSON.parse(stored.get('chat.sessions') ?? '[]')).toHaveLength(1)
    release()
    hold = null
    await store.readAll()
    await settle()
    const ids = (JSON.parse(stored.get('chat.sessions') ?? '[]') as { id: string }[]).map(s => s.id)
    expect(ids).toContain('old')
    expect(ids).toHaveLength(2)
  })

  it('save replaces a session by id rather than duplicating it', async () => {
    const store = await freshStore()
    const session = store.newSession(message('user', 'q'))
    await store.save(session)
    await store.save({ ...session, messages: [...session.messages, message('model', 'a')] })
    const all = await store.readAll()
    expect(all).toHaveLength(1)
    expect(all[0].messages).toHaveLength(2)
  })

  it('remove deletes the session from memory and storage', async () => {
    const store = await freshStore()
    const session = store.newSession(message('user', 'q'))
    await store.save(session)
    await store.remove(session.id)
    await settle()
    expect(await store.readAll()).toHaveLength(0)
    expect(JSON.parse(stored.get('chat.sessions') ?? '[]')).toHaveLength(0)
  })

  it('keeps stored history under the size budget, dropping the oldest first', async () => {
    const store = await freshStore()
    const long = 'x'.repeat(3000)
    for (let i = 0; i < 10; i++) {
      const s = store.newSession(message('user', `q${i}`))
      await store.save({ ...s, messages: [...s.messages, message('model', long)] })
    }
    await settle()
    const raw = stored.get('chat.sessions') ?? ''
    expect(raw.length).toBeLessThanOrEqual(20_000)
    const titles = (await store.readAll()).map(s => s.title)
    expect(titles).toContain('q9')
    expect(titles).not.toContain('q0')
  })

  it('treats unreadable stored data as no chats rather than failing', async () => {
    stored.set('chat.sessions', '{not json')
    const store = await freshStore()
    expect(await store.readAll()).toEqual([])
  })
})
