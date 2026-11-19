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

// The saved history as one string, read the way the store reads it
// (G2-170): the chunks of the set the pointer names.
function storedBlob(): string {
  const pointer = /^(a|b):(\d+)$/.exec(stored.get('chat.sessions.current') ?? '')
  if (!pointer) return stored.get('chat.sessions') ?? ''
  let text = ''
  for (let i = 0; i < Number(pointer[2]); i++) {
    text += stored.get(`chat.sessions.${pointer[1]}.${i}`) ?? ''
  }
  return text
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
    const raw = storedBlob()
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
    expect(storedBlob()).not.toContain(curly)
    expect(storedBlob()).toContain('\\u2019')
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
    expect(JSON.parse(storedBlob() ?? '[]')).toHaveLength(1)
    release()
    hold = null
    await store.readAll()
    await settle()
    const ids = (JSON.parse(storedBlob() ?? '[]') as { id: string }[]).map(s => s.id)
    expect(ids).toContain('old')
    expect(ids).toHaveLength(2)
  })

  it('once loaded, a new chat is in peek as soon as save is called, before it is awaited', async () => {
    // A new chat's id goes to the phone page right after an unawaited save;
    // if peek missed it, the page sent the glasses back to the list (G2-156).
    const store = await freshStore()
    await store.readAll()
    const session = store.newSession(message('user', 'first question'))
    void store.save(session)
    expect(store.peek()?.map(s => s.id)).toEqual([session.id])
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
    expect(JSON.parse(storedBlob() ?? '[]')).toHaveLength(0)
  })

  it('keeps stored history under the size budget, dropping the oldest first', async () => {
    const store = await freshStore()
    const long = 'x'.repeat(40_000)
    for (let i = 0; i < 10; i++) {
      const s = store.newSession(message('user', `q${i}`))
      await store.save({ ...s, messages: [...s.messages, message('model', long)] })
    }
    await settle()
    const raw = storedBlob()
    expect(raw.length).toBeLessThanOrEqual(300_000)
    const titles = (await store.readAll()).map(s => s.title)
    expect(titles).toContain('q9')
    expect(titles).not.toContain('q0')
  })

  it('keeps 30 coding-length chats, stored in chunks, and reads them all back (G2-170)', async () => {
    const store = await freshStore()
    const answer = 'x'.repeat(3000)
    for (let i = 0; i < 30; i++) {
      const s = store.newSession(message('user', `q${i}`))
      await store.save({ ...s, messages: [...s.messages, message('model', answer)] })
    }
    await settle()
    expect(stored.get('chat.sessions.current')).toMatch(/^[ab]:[2-9]$/)
    const again = await freshStore()
    expect(await again.readAll()).toHaveLength(30)
  })

  it('moves chats from the old single key into chunks and clears it', async () => {
    stored.set(
      'chat.sessions',
      JSON.stringify([{ id: 'old', title: 'Old', messages: [], updatedAt: 1 }]),
    )
    const store = await freshStore()
    await store.readAll()
    await settle()
    expect(stored.get('chat.sessions')).toBe('')
    expect(JSON.parse(storedBlob()).map((s: { id: string }) => s.id)).toEqual(['old'])
  })

  it('a save cut off before the pointer flips leaves the previous history intact', async () => {
    const store = await freshStore()
    await store.save(store.newSession(message('user', 'kept')))
    await settle()
    const before = storedBlob()
    // The next save writes its chunks, then fails on the pointer.
    const realSet = stored.set.bind(stored)
    stored.set = (key: string, value: string) =>
      key === 'chat.sessions.current' ? stored : realSet(key, value)
    await store.save(store.newSession(message('user', 'lost')))
    await settle()
    stored.set = realSet
    expect(storedBlob()).toBe(before)
  })

  it('treats unreadable stored data as no chats rather than failing', async () => {
    stored.set('chat.sessions', '{not json')
    const store = await freshStore()
    expect(await store.readAll()).toEqual([])
  })
})
