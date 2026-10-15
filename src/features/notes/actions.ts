import type { AssistantAction } from '../../core/assistantActions'
import { newId } from '../../platform/collection'
import {
  notes,
  NOTE_ITEM_MAX_CHARS,
  NOTE_MAX_ITEMS,
  type ChecklistItem,
  type NoteDoc,
} from './store'

// What Jarvis can do to the wearer's checklists by voice (see
// core/assistantActions.ts for how a spoken request becomes one of these).
// Deliberately no "delete a whole list": destructive, hard to undo, and a
// misheard list name would take the wrong one - that stays a companion-page
// action, same rule as deleting a chat (docs/roadmap.md, principle 5).
//
// Each operation below is a pure function over the full set of notes: it
// returns what to write back (or null for "nothing changed") plus the
// sentence to show. Pure so the matching rules - the part most likely to be
// wrong - are testable without storage. notes.mutate does the read and the
// write around them.

type Outcome = { next: NoteDoc[] | null; result: string }

// The name a wearer says is rarely the stored title exactly: "my shopping
// list", "the Shopping list" and "shopping" all mean a list titled
// "Shopping". Lower case, punctuation gone, a leading my/the/a and a
// trailing "list" or "checklist" dropped.
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(my|the|a|our) /, '')
    .replace(/ ?(check ?list|list)$/, '')
    .trim()
}

// Plurals compared loosely ("reminder" / "reminders"), on top of
// normalizeName.
function sameName(a: string, b: string): boolean {
  const strip = (s: string) => (s.length > 3 ? s.replace(/s$/, '') : s)
  return strip(normalizeName(a)) === strip(normalizeName(b))
}

// Exact (normalized) title first. Failing that, a list whose name contains
// the spoken one or the other way round - but only when exactly one list
// matches that way, never a guess between two.
export function findList(all: readonly NoteDoc[], name: string): NoteDoc | null {
  const exact = all.find(n => sameName(n.title, name))
  if (exact) return exact
  const spoken = normalizeName(name)
  if (spoken.length < 3) return null
  const partial = all.filter(n => {
    const title = normalizeName(n.title)
    return title.length > 0 && (title.includes(spoken) || spoken.includes(title))
  })
  return partial.length === 1 ? partial[0] : null
}

// Same idea for items: exact first, then contains in either direction.
// Every match is returned so the caller can refuse an ambiguous one
// ("milk" with both "oat milk" and "milk chocolate" on the list).
function matchItems(note: NoteDoc, text: string): ChecklistItem[] {
  const spoken = normalizeName(text)
  if (spoken.length === 0) return []
  const exact = note.items.filter(i => sameName(i.text, text))
  if (exact.length > 0) return exact
  return note.items.filter(i => {
    const item = normalizeName(i.text)
    return (
      item.length > 0 && (item.includes(spoken) || (spoken.length >= 3 && spoken.includes(item)))
    )
  })
}

function titleOf(note: NoteDoc): string {
  return note.title || '(untitled)'
}

export function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join('')
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

function noSuchList(all: readonly NoteDoc[], name: string): string {
  const names = all.map(titleOf)
  return names.length > 0
    ? `You don't have a list called ${name}. Your lists: ${joinWords(names)}.`
    : `You don't have a list called ${name} - you have no lists yet.`
}

function replace(all: readonly NoteDoc[], note: NoteDoc): NoteDoc[] {
  return all.map(n => (n.id === note.id ? note : n))
}

// A new list's title. Long enough for any real name, short enough for the
// glasses picker, which shows the title and a count on one row.
const LIST_TITLE_MAX_CHARS = 40

function newListTitle(name: string): string {
  return name.trim().replace(/\s+/g, ' ').slice(0, LIST_TITLE_MAX_CHARS)
}

export function addToList(
  all: readonly NoteDoc[],
  listName: string,
  itemTexts: readonly string[],
  now: number,
): Outcome {
  const texts = itemTexts.map(t => t.trim().slice(0, NOTE_ITEM_MAX_CHARS)).filter(t => t.length > 0)
  if (!listName.trim()) return { next: null, result: 'Which list should that go on?' }
  if (texts.length === 0) return { next: null, result: 'There was nothing to add.' }

  const existing = findList(all, listName)
  const note: NoteDoc = existing
    ? { ...existing, items: existing.items.map(i => ({ ...i })) }
    : { id: newId(), title: newListTitle(listName), items: [], updatedAt: now }

  const added: string[] = []
  const reopened: string[] = []
  const already: string[] = []
  const noRoom: string[] = []
  for (const text of texts) {
    const same = note.items.find(i => sameName(i.text, text))
    if (same) {
      // Saying it again after it was ticked off means it is needed again.
      if (same.done) {
        same.done = false
        reopened.push(same.text)
      } else {
        already.push(same.text)
      }
      continue
    }
    if (note.items.length >= NOTE_MAX_ITEMS) {
      noRoom.push(text)
      continue
    }
    note.items.push({ id: newId(), text, done: false })
    added.push(text)
  }

  const title = titleOf(note)
  const sentences: string[] = []
  if (added.length > 0) {
    sentences.push(`Added ${joinWords(added)} to ${title}${existing ? '' : ' (new list)'}.`)
  }
  if (reopened.length > 0) sentences.push(`Put ${joinWords(reopened)} back on ${title}.`)
  if (already.length > 0) {
    const verb = already.length === 1 ? 'is' : 'are'
    sentences.push(`${joinWords(already)} ${verb} already on ${title}.`)
  }
  if (noRoom.length > 0) {
    sentences.push(
      `${title} is full (${NOTE_MAX_ITEMS} items) - couldn't add ${joinWords(noRoom)}.`,
    )
  }

  const changed = added.length > 0 || reopened.length > 0
  if (!changed) return { next: null, result: sentences.join(' ') }
  note.updatedAt = now
  return { next: existing ? replace(all, note) : [...all, note], result: sentences.join(' ') }
}

export function readList(all: readonly NoteDoc[], listName: string): string {
  const note = findList(all, listName)
  if (!note) return noSuchList(all, listName)
  const title = titleOf(note)
  if (note.items.length === 0) return `${title} is empty.`
  const open = note.items.filter(i => !i.done)
  const done = note.items.filter(i => i.done)
  if (open.length === 0) return `Everything on ${title} is done (${done.length}).`
  const lines = [`${title} (${open.length} to go):`, ...open.map(i => `- ${i.text}`)]
  if (done.length > 0) lines.push(`Done: ${joinWords(done.map(i => i.text))}`)
  return lines.join('\n')
}

export function listLists(all: readonly NoteDoc[]): string {
  if (all.length === 0) return 'You have no lists yet.'
  const names = all.map(n => {
    const open = n.items.filter(i => !i.done).length
    return `${titleOf(n)} (${open} to go)`
  })
  return `Your lists: ${joinWords(names)}.`
}

function ambiguous(title: string, text: string, matches: readonly ChecklistItem[]): string {
  return `More than one item on ${title} matches "${text}": ${joinWords(matches.map(i => i.text))}. Nothing changed.`
}

export function checkOff(
  all: readonly NoteDoc[],
  listName: string,
  itemText: string,
  now: number,
): Outcome {
  const note = findList(all, listName)
  if (!note) return { next: null, result: noSuchList(all, listName) }
  const title = titleOf(note)
  const matches = matchItems(note, itemText)
  if (matches.length === 0) return { next: null, result: `"${itemText}" isn't on ${title}.` }
  // Two matches where only one is still open is not really ambiguous -
  // the open one is the one being ticked off.
  const open = matches.filter(i => !i.done)
  const target = matches.length === 1 ? matches[0] : open.length === 1 ? open[0] : null
  if (!target) return { next: null, result: ambiguous(title, itemText, matches) }
  if (target.done) return { next: null, result: `${target.text} was already checked off.` }
  const updated: NoteDoc = {
    ...note,
    items: note.items.map(i => (i.id === target.id ? { ...i, done: true } : i)),
    updatedAt: now,
  }
  const left = updated.items.filter(i => !i.done).length
  const tail = left === 0 ? ` That's everything on ${title}.` : ` ${left} left.`
  return { next: replace(all, updated), result: `Checked off ${target.text}.${tail}` }
}

export function removeItem(
  all: readonly NoteDoc[],
  listName: string,
  itemText: string,
  now: number,
): Outcome {
  const note = findList(all, listName)
  if (!note) return { next: null, result: noSuchList(all, listName) }
  const title = titleOf(note)
  const matches = matchItems(note, itemText)
  if (matches.length === 0) return { next: null, result: `"${itemText}" isn't on ${title}.` }
  if (matches.length > 1) return { next: null, result: ambiguous(title, itemText, matches) }
  const target = matches[0]
  const updated: NoteDoc = {
    ...note,
    items: note.items.filter(i => i.id !== target.id),
    updatedAt: now,
  }
  return { next: replace(all, updated), result: `Removed ${target.text} from ${title}.` }
}

export function clearDone(all: readonly NoteDoc[], listName: string, now: number): Outcome {
  const note = findList(all, listName)
  if (!note) return { next: null, result: noSuchList(all, listName) }
  const title = titleOf(note)
  const done = note.items.filter(i => i.done).length
  if (done === 0) return { next: null, result: `Nothing on ${title} is checked off yet.` }
  const updated: NoteDoc = { ...note, items: note.items.filter(i => !i.done), updatedAt: now }
  const word = done === 1 ? 'item' : 'items'
  return { next: replace(all, updated), result: `Cleared ${done} finished ${word} from ${title}.` }
}

// For Gemini's system instruction (see AssistantActionSet.context): the
// exact names of the wearer's lists, so it can use one instead of
// inventing a near-duplicate.
export function describeLists(all: readonly NoteDoc[]): string {
  if (all.length === 0) return 'The wearer has no lists yet.'
  return `The wearer's lists: ${all.map(n => `"${titleOf(n)}"`).join(', ')}.`
}

// --- Gemini-facing wrappers -------------------------------------------------

// Arguments come from the model, so nothing about their types is trusted.
function str(x: unknown): string {
  return typeof x === 'string' ? x : ''
}

function strings(x: unknown): string[] {
  if (Array.isArray(x)) return x.filter((v): v is string => typeof v === 'string')
  return typeof x === 'string' ? [x] : []
}

const LIST_PARAM = {
  type: 'STRING' as const,
  description: 'The name of the list, as the wearer said it or one of their existing list names.',
}

const ITEM_PARAM = {
  type: 'STRING' as const,
  description: 'The item, as the wearer said it.',
}

export const notesActions: AssistantAction[] = [
  {
    declaration: {
      name: 'add_to_list',
      description:
        "Add one or more items to one of the wearer's checklists, creating the list if it " +
        'does not exist. Also used for "remind me to ..." (list name Reminders).',
      parameters: {
        type: 'OBJECT',
        properties: {
          list: LIST_PARAM,
          items: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            description: 'The items to add, each one short.',
          },
        },
        required: ['list', 'items'],
      },
    },
    run: args =>
      notes.mutate(all => addToList(all, str(args.list), strings(args.items), Date.now())),
  },
  {
    declaration: {
      name: 'read_list',
      description: "Show what is on one of the wearer's checklists.",
      parameters: { type: 'OBJECT', properties: { list: LIST_PARAM }, required: ['list'] },
    },
    run: async args => readList(await notes.readAll(), str(args.list)),
  },
  {
    declaration: {
      name: 'list_lists',
      description: 'Name all of the wearer\'s checklists, e.g. for "what lists do I have".',
    },
    run: async () => listLists(await notes.readAll()),
  },
  {
    declaration: {
      name: 'check_off_item',
      description: "Mark an item on one of the wearer's checklists as done.",
      parameters: {
        type: 'OBJECT',
        properties: { list: LIST_PARAM, item: ITEM_PARAM },
        required: ['list', 'item'],
      },
    },
    run: args => notes.mutate(all => checkOff(all, str(args.list), str(args.item), Date.now())),
  },
  {
    declaration: {
      name: 'remove_item',
      description: "Take an item off one of the wearer's checklists entirely.",
      parameters: {
        type: 'OBJECT',
        properties: { list: LIST_PARAM, item: ITEM_PARAM },
        required: ['list', 'item'],
      },
    },
    run: args => notes.mutate(all => removeItem(all, str(args.list), str(args.item), Date.now())),
  },
  {
    declaration: {
      name: 'clear_done_items',
      description: "Remove every checked-off item from one of the wearer's checklists.",
      parameters: { type: 'OBJECT', properties: { list: LIST_PARAM }, required: ['list'] },
    },
    run: args => notes.mutate(all => clearDone(all, str(args.list), Date.now())),
  },
]
