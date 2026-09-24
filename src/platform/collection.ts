import { bridge, status } from './bridge'

// Generic CRUD over a JSON array in on-device storage, for collections shaped
// as {id, title, body, updatedAt}. Teleprompter scripts use it. Notes used to,
// until they became checklists with their own shape (features/notes/store.ts).
//
// This lives entirely on-device via bridge.setLocalStorage. No server: the
// phone companion page and the code driving the glasses are the same running
// JS instance, so there is nothing to sync between two places.
export type Item = {
  id: string
  title: string
  body: string
  updatedAt: number
}

function isItem(x: unknown): x is Item {
  if (!x || typeof x !== 'object') return false
  const i = x as Record<string, unknown>
  return (
    typeof i.id === 'string' &&
    typeof i.title === 'string' &&
    typeof i.body === 'string' &&
    typeof i.updatedAt === 'number'
  )
}

// Good enough for a per-device, unsynced id: unique within one wearer's own
// storage is the only guarantee ever required here.
export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function makeCollection(storageKey: string) {
  async function readAll(): Promise<Item[]> {
    try {
      const raw = await bridge.getLocalStorage(storageKey)
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter(isItem)
    } catch {
      return []
    }
  }

  function writeAll(items: Item[]): Promise<boolean> {
    return bridge.setLocalStorage(storageKey, JSON.stringify(items)).then(ok => {
      if (!ok) status(`Failed to save ${storageKey}`)
      return ok
    })
  }

  async function create(title: string, body: string): Promise<Item> {
    const items = await readAll()
    const item: Item = { id: newId(), title, body, updatedAt: Date.now() }
    await writeAll([...items, item])
    return item
  }

  async function update(id: string, title: string, body: string): Promise<void> {
    const items = await readAll()
    const next = items.map(i => (i.id === id ? { ...i, title, body, updatedAt: Date.now() } : i))
    await writeAll(next)
  }

  async function remove(id: string): Promise<void> {
    const items = await readAll()
    await writeAll(items.filter(i => i.id !== id))
  }

  return { readAll, create, update, remove }
}
