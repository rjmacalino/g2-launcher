import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/platform/bridge', () => ({
  bridge: { getLocalStorage: async () => '', setLocalStorage: async () => true },
  status: vi.fn(),
}))

import {
  addToList,
  checkOff,
  clearDone,
  findList,
  listLists,
  normalizeName,
  readList,
  removeItem,
} from '../src/features/notes/actions'
import type { NoteDoc } from '../src/features/notes/store'

function note(title: string, items: [string, boolean][], id = title): NoteDoc {
  return {
    id,
    title,
    items: items.map(([text, done], i) => ({ id: `${id}-${i}`, text, done })),
    updatedAt: 1,
  }
}

function texts(n: NoteDoc | undefined): string[] {
  return (n?.items ?? []).map(i => `${i.done ? 'x' : ' '} ${i.text}`)
}

const NOW = 1000

describe('normalizeName / findList', () => {
  it('ignores my/the, a trailing "list", case and punctuation', () => {
    expect(normalizeName('My Shopping List!')).toBe('shopping')
    expect(normalizeName('the to-do checklist')).toBe('to do')
  })

  it('finds a list by the way it is spoken', () => {
    const all = [note('Shopping', []), note('Reminders', [])]
    expect(findList(all, 'my shopping list')?.title).toBe('Shopping')
    expect(findList(all, 'reminder')?.title).toBe('Reminders')
  })

  it('accepts a partial match only when it is unambiguous', () => {
    expect(findList([note('Weekly shopping', [])], 'shopping')?.title).toBe('Weekly shopping')
    expect(findList([note('Weekly shopping', []), note('Shopping ideas', [])], 'shopping')).toBe(
      null,
    )
  })
})

describe('addToList', () => {
  it('adds to an existing list', () => {
    const all = [note('Shopping', [['eggs', false]])]
    const out = addToList(all, 'shopping list', ['milk', 'bread'], NOW)
    expect(out.result).toBe('Added milk and bread to Shopping.')
    expect(texts(out.next?.[0])).toEqual(['  eggs', '  milk', '  bread'])
  })

  it('creates the list when it does not exist', () => {
    const out = addToList([], 'Reminders', ['call mom'], NOW)
    expect(out.result).toBe('Added call mom to Reminders (new list).')
    expect(out.next?.[0].title).toBe('Reminders')
    expect(texts(out.next?.[0])).toEqual(['  call mom'])
  })

  it('does not duplicate an open item, and reopens a done one', () => {
    const all = [
      note('Shopping', [
        ['Eggs', false],
        ['milk', true],
      ]),
    ]
    const out = addToList(all, 'Shopping', ['eggs', 'milk'], NOW)
    expect(out.result).toBe('Put milk back on Shopping. Eggs is already on Shopping.')
    expect(texts(out.next?.[0])).toEqual(['  Eggs', '  milk'])
  })

  it('writes nothing when nothing changed', () => {
    const out = addToList([note('Shopping', [['eggs', false]])], 'Shopping', ['eggs'], NOW)
    expect(out.next).toBe(null)
  })

  it('stops at the platform limit of 20 items and says what did not fit', () => {
    const full = note(
      'Big',
      Array.from({ length: 19 }, (_, i): [string, boolean] => [`item ${i}`, false]),
    )
    const out = addToList([full], 'Big', ['one more', 'too many'], NOW)
    expect(out.result).toBe(
      "Added one more to Big. Big is full (20 items) - couldn't add too many.",
    )
    expect(out.next?.[0].items).toHaveLength(20)
  })

  it('leaves other lists untouched', () => {
    const all = [note('Shopping', []), note('Reminders', [['x', false]])]
    const out = addToList(all, 'Shopping', ['eggs'], NOW)
    expect(out.next?.[1]).toBe(all[1])
  })
})

describe('readList / listLists', () => {
  it('shows open items, then what is done', () => {
    const all = [
      note('Shopping', [
        ['eggs', false],
        ['milk', true],
        ['bread', false],
      ]),
    ]
    expect(readList(all, 'shopping')).toBe('Shopping (2 to go):\n- eggs\n- bread\nDone: milk')
  })

  it('names the lists that do exist when asked for one that does not', () => {
    const all = [note('Shopping', []), note('Reminders', [])]
    expect(readList(all, 'packing')).toBe(
      "You don't have a list called packing. Your lists: Shopping and Reminders.",
    )
  })

  it('lists every list with what is left on it', () => {
    const all = [
      note('Shopping', [
        ['eggs', false],
        ['milk', true],
      ]),
      note('Reminders', []),
    ]
    expect(listLists(all)).toBe('Your lists: Shopping (1 to go) and Reminders (0 to go).')
  })
})

describe('checkOff / removeItem / clearDone', () => {
  it('checks off a partially named item', () => {
    const all = [
      note('Shopping', [
        ['oat milk', false],
        ['eggs', false],
      ]),
    ]
    const out = checkOff(all, 'Shopping', 'milk', NOW)
    expect(out.result).toBe('Checked off oat milk. 1 left.')
    expect(texts(out.next?.[0])).toEqual(['x oat milk', '  eggs'])
  })

  it('refuses to guess between two matching items', () => {
    const all = [
      note('Shopping', [
        ['oat milk', false],
        ['milk chocolate', false],
      ]),
    ]
    const out = checkOff(all, 'Shopping', 'milk', NOW)
    expect(out.next).toBe(null)
    expect(out.result).toContain('More than one item')
  })

  it('picks the only open one when the other match is already done', () => {
    const all = [
      note('Shopping', [
        ['oat milk', true],
        ['milk chocolate', false],
      ]),
    ]
    expect(checkOff(all, 'Shopping', 'milk', NOW).result).toBe(
      "Checked off milk chocolate. That's everything on Shopping.",
    )
  })

  it('removes an item', () => {
    const all = [
      note('Shopping', [
        ['eggs', false],
        ['milk', false],
      ]),
    ]
    const out = removeItem(all, 'Shopping', 'eggs', NOW)
    expect(out.result).toBe('Removed eggs from Shopping.')
    expect(texts(out.next?.[0])).toEqual(['  milk'])
  })

  it('clears finished items only', () => {
    const all = [
      note('Shopping', [
        ['eggs', true],
        ['milk', false],
        ['jam', true],
      ]),
    ]
    const out = clearDone(all, 'Shopping', NOW)
    expect(out.result).toBe('Cleared 2 finished items from Shopping.')
    expect(texts(out.next?.[0])).toEqual(['  milk'])
  })

  it('says so when the item is not there', () => {
    const out = removeItem([note('Shopping', [['eggs', false]])], 'Shopping', 'butter', NOW)
    expect(out).toEqual({ next: null, result: '"butter" isn\'t on Shopping.' })
  })
})
