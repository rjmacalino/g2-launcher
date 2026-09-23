import { bridge, status } from './bridge'

// Generic CRUD over a JSON array in local storage. Notes and scripts are
// structurally identical (id, title, body, updatedAt), so one implementation
// serves both rather than writing the same read/parse/write logic twice. If a
// third collection like this shows up, this is the file to extend.
//
// This lives entirely on-device via bridge.setLocalStorage. No server, no
// network, no Docker: the phone companion page and the code driving the
// glasses are the same running JS instance, so there is nothing to sync
// between two places. That is different from weather, which needs a real
// external data source and cannot avoid a backend.
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
function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function makeCollection(storageKey: string) {
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

export const notes = makeCollection('notes.list')
export const scripts = makeCollection('scripts.list')

// Which saved script the teleprompter currently shows. A separate key rather
// than a field on the script itself, because "currently active" is a property
// of the teleprompter tool, not of the script, and a script should not need
// editing just to stop being the active one.
const ACTIVE_SCRIPT_KEY = 'scripts.activeId'

export async function getActiveScriptId(): Promise<string | null> {
  try {
    const raw = await bridge.getLocalStorage(ACTIVE_SCRIPT_KEY)
    // Every plausible representation of "nothing stored" collapses to null
    // here, same defensive shape as readStoredLine in the teleprompter's
    // earlier position-tracking code: empty string, and the literal strings
    // a host might return for an unset key.
    if (!raw || raw === 'null' || raw === 'undefined') return null
    return raw
  } catch {
    return null
  }
}

export function setActiveScriptId(id: string): Promise<boolean> {
  return bridge.setLocalStorage(ACTIVE_SCRIPT_KEY, id).then(ok => {
    if (!ok) status('Failed to set active script')
    return ok
  })
}
