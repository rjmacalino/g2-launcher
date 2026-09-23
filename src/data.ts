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

export const scripts = makeCollection('scripts.list')

// Notes are checklists, not free text: a title plus short, independent line
// items, each with its own done state. Deliberately not the same shape as
// scripts. A script is one long thing meant to be read continuously; a note
// is a set of separate small things meant to be ticked off one at a time, and
// those need different data (per-item done flags) and different operations
// (toggle one item without touching the rest) that a shared {title, body}
// shape cannot express.
export type ChecklistItem = {
  id: string
  text: string
  done: boolean
}

export type NoteDoc = {
  id: string
  title: string
  items: ChecklistItem[]
  updatedAt: number
}

function isChecklistItem(x: unknown): x is ChecklistItem {
  if (!x || typeof x !== 'object') return false
  const i = x as Record<string, unknown>
  return typeof i.id === 'string' && typeof i.text === 'string' && typeof i.done === 'boolean'
}

function isNoteDoc(x: unknown): x is NoteDoc {
  if (!x || typeof x !== 'object') return false
  const n = x as Record<string, unknown>
  return (
    typeof n.id === 'string' &&
    typeof n.title === 'string' &&
    Array.isArray(n.items) &&
    n.items.every(isChecklistItem) &&
    typeof n.updatedAt === 'number'
  )
}

const NOTES_STORAGE_KEY = 'notes.list'

async function readAllNotes(): Promise<NoteDoc[]> {
  try {
    const raw = await bridge.getLocalStorage(NOTES_STORAGE_KEY)
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isNoteDoc)
  } catch {
    return []
  }
}

function writeAllNotes(all: NoteDoc[]): Promise<boolean> {
  return bridge.setLocalStorage(NOTES_STORAGE_KEY, JSON.stringify(all)).then(ok => {
    if (!ok) status('Failed to save notes')
    return ok
  })
}

// Platform limits, not arbitrary choices: a list holds at most 20 items of at
// most 64 characters each. Clamped here, at the one place every write to a
// note passes through, rather than trusted to whichever caller happens to
// remember. The glasses tool also clamps defensively (see notes.ts) since it
// is the one place a limit violation would actually break something, but the
// authoritative enforcement belongs at the write, not at every reader.
export const NOTE_MAX_ITEMS = 20
export const NOTE_ITEM_MAX_CHARS = 64

function sanitizeItemTexts(texts: string[]): string[] {
  return texts
    .map(t => t.trim())
    .filter(t => t.length > 0)
    .slice(0, NOTE_MAX_ITEMS)
    .map(t => t.slice(0, NOTE_ITEM_MAX_CHARS))
}

async function createNote(title: string, itemTexts: string[]): Promise<NoteDoc> {
  const all = await readAllNotes()
  const note: NoteDoc = {
    id: newId(),
    title,
    items: sanitizeItemTexts(itemTexts).map(text => ({ id: newId(), text, done: false })),
    updatedAt: Date.now(),
  }
  await writeAllNotes([...all, note])
  return note
}

// Item identity is positional, not tracked by the phone's plain-text editor
// (there is nowhere to hang a stable id on a row of text inputs without a
// much heavier editor). Done state is preserved when a row's text is
// unchanged from what was there before; a row whose text changed is treated
// as a different item and starts unchecked, since we cannot tell "edited this
// item" apart from "replaced it with a different one" from text alone.
async function updateNote(id: string, title: string, itemTexts: string[]): Promise<void> {
  const all = await readAllNotes()
  const existing = all.find(n => n.id === id)
  const items: ChecklistItem[] = sanitizeItemTexts(itemTexts).map((text, i) => {
    const prior = existing?.items[i]
    return { id: prior?.id ?? newId(), text, done: prior?.text === text ? prior.done : false }
  })
  const next = all.map(n => (n.id === id ? { ...n, title, items, updatedAt: Date.now() } : n))
  await writeAllNotes(next)
}

async function removeNote(id: string): Promise<void> {
  const all = await readAllNotes()
  await writeAllNotes(all.filter(n => n.id !== id))
}

// Persist a note exactly as given, rather than recomputing a diff. The
// glasses tool mutates its own in-memory copy directly (toggling one item's
// done flag) and calls this to write that same object back, so there is one
// source of truth for what a toggle does rather than the tool and the data
// layer each maintaining their own idea of it.
async function saveNote(note: NoteDoc): Promise<boolean> {
  const all = await readAllNotes()
  const next = all.map(n => (n.id === note.id ? note : n))
  return writeAllNotes(next)
}

async function resetNoteItems(id: string): Promise<boolean> {
  const all = await readAllNotes()
  const next = all.map(n =>
    n.id === id ? { ...n, items: n.items.map(it => ({ ...it, done: false })), updatedAt: Date.now() } : n,
  )
  return writeAllNotes(next)
}

export const notes = {
  readAll: readAllNotes,
  create: createNote,
  update: updateNote,
  remove: removeNote,
  save: saveNote,
  resetItems: resetNoteItems,
}

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
