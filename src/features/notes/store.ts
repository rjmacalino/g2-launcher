import { bridge, status } from '../../platform/bridge'
import { newId } from '../../platform/collection'

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

// Notes can now change from three places in the same running app: the
// companion page, the glasses' Notes screen, and Jarvis acting on a spoken
// request (features/notes/actions.ts). Anything showing notes subscribes
// here to redraw after a write it did not make itself - the companion's
// list, most usefully, so "add eggs to my shopping list" appears there
// while it is open.
const changeListeners = new Set<() => void>()

export function onNotesChange(fn: () => void): () => void {
  changeListeners.add(fn)
  return () => changeListeners.delete(fn)
}

function writeAllNotes(all: NoteDoc[]): Promise<boolean> {
  return bridge.setLocalStorage(NOTES_STORAGE_KEY, JSON.stringify(all)).then(ok => {
    if (!ok) status('Failed to save notes')
    if (ok) for (const fn of changeListeners) fn()
    return ok
  })
}

// Read, change and write back as one step, one at a time. Jarvis can be
// asked for several changes in one sentence ("add eggs to shopping and
// remind me to call mom" arrives as two separate actions), and two
// overlapping read-then-write cycles would each write back a copy missing
// the other's change. change returns the full new list to write, or null
// for "nothing changed, write nothing".
let mutateQueue: Promise<unknown> = Promise.resolve()

function mutateNotes<T>(
  change: (all: NoteDoc[]) => { next: NoteDoc[] | null; result: T },
): Promise<T> {
  const run = mutateQueue.then(async () => {
    const { next, result } = change(await readAllNotes())
    if (next) await writeAllNotes(next)
    return result
  })
  mutateQueue = run.catch(() => undefined)
  return run
}

// Platform limits, not arbitrary choices: a list holds at most 20 items of at
// most 64 characters each. Clamped here, at the one place every write to a
// note passes through, rather than trusted to whichever caller happens to
// remember. The glasses tool also clamps defensively (see tool.ts) since it
// is the one place a limit violation would actually break something, but the
// authoritative enforcement belongs at the write, not at every reader.
export const NOTE_MAX_ITEMS = 20
export const NOTE_ITEM_MAX_CHARS = 64

export function sanitizeItemTexts(texts: string[]): string[] {
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
    n.id === id
      ? { ...n, items: n.items.map(it => ({ ...it, done: false })), updatedAt: Date.now() }
      : n,
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
  mutate: mutateNotes,
}
