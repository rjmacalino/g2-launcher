import {
  notes,
  onNotesChange,
  sanitizeItemTexts,
  NOTE_ITEM_MAX_CHARS,
  NOTE_MAX_ITEMS,
  type NoteDoc,
} from '../../features/notes/store'
import { newId } from '../../platform/collection'
import type { AppContext, Page, Route } from '../app'
import { formatWhen, h, icon, isTyping, toast } from '../dom'

// The Notes tab (G2-71): checklists, made and edited here - typing is the
// phone's job - and worked through on the glasses hands-free. Every change
// is saved at once (through the store's one-at-a-time mutate, so it never
// races Jarvis or the glasses) and shows on the glasses straight away.

let cache: NoteDoc[] | null = null

function load(ctx: AppContext): NoteDoc[] {
  if (cache === null) {
    void notes.readAll().then(all => {
      cache = all
      ctx.refresh()
    })
    return []
  }
  return cache
}

// Changes one note by id, in the store, and keeps the local copy in step.
async function change(id: string, edit: (note: NoteDoc) => NoteDoc | null): Promise<void> {
  await notes.mutate(all => {
    const index = all.findIndex(n => n.id === id)
    if (index < 0) return { next: null, result: null }
    const edited = edit(all[index])
    if (!edited) return { next: null, result: null }
    const next = [...all]
    next[index] = { ...edited, updatedAt: Date.now() }
    cache = next
    return { next, result: null }
  })
}

function listPage(ctx: AppContext): Page {
  const all = [...load(ctx)].sort((a, b) => b.updatedAt - a.updatedAt)
  const body = h(
    'div',
    {},
    h(
      'button',
      {
        class: 'button primary block',
        onclick: async () => {
          const created = await notes.create('', [])
          cache = null
          ctx.navigate({ tab: 'notes', noteId: created.id })
        },
      },
      icon('plus'),
      'New list',
    ),
    all.length === 0
      ? h(
          'div',
          { class: 'empty' },
          icon('notes'),
          h('h2', {}, 'No lists yet'),
          h('div', {}, 'Make one here, or ask Jarvis: "add milk to my shopping list".'),
        )
      : [
          h('div', { class: 'section-label' }, 'Lists'),
          h(
            'ul',
            { class: 'list' },
            all.map(note => {
              const done = note.items.filter(i => i.done).length
              const total = note.items.length
              return h(
                'li',
                {},
                h(
                  'button',
                  {
                    class: 'row',
                    onclick: () => ctx.navigate({ tab: 'notes', noteId: note.id }),
                  },
                  h(
                    'div',
                    { class: 'row-main' },
                    h(
                      'div',
                      { class: 'row-title' },
                      h('span', { class: 'text' }, note.title || '(untitled)'),
                    ),
                    h(
                      'div',
                      { class: 'row-sub' },
                      `${total === 0 ? 'Empty' : `${done} of ${total} done`} - ${formatWhen(note.updatedAt)}`,
                    ),
                    total > 0
                      ? h(
                          'div',
                          { class: 'progress' },
                          h('i', { style: `width: ${(done / total) * 100}%` }),
                        )
                      : null,
                  ),
                  icon('chevron', 'chevron'),
                ),
              )
            }),
          ),
        ],
  )
  const stop = onNotesChange(() => {
    cache = null
    ctx.refresh()
  })
  return { title: 'Notes', body, cleanup: () => stop() }
}

function notePage(ctx: AppContext, noteId: string): Page {
  const note = load(ctx).find(n => n.id === noteId)
  if (!note) {
    if (cache !== null) queueMicrotask(() => ctx.navigate({ tab: 'notes' }, { replace: true }))
    return { title: 'Notes', back: { tab: 'notes' }, body: h('div') }
  }

  const title = h('input', {
    class: 'title-field',
    value: note.title,
    placeholder: 'List name',
    maxlength: String(NOTE_ITEM_MAX_CHARS),
    'aria-label': 'List name',
  }) as HTMLInputElement
  title.addEventListener('change', () => change(noteId, n => ({ ...n, title: title.value.trim() })))

  const items = h(
    'div',
    { class: 'list' },
    note.items.map(item => {
      const text = h('input', {
        class: 'check-text',
        value: item.text,
        maxlength: String(NOTE_ITEM_MAX_CHARS),
        'aria-label': 'Item',
      }) as HTMLInputElement
      text.addEventListener('change', () => {
        const value = text.value.trim()
        void change(noteId, n => ({
          ...n,
          items: value
            ? n.items.map(i => (i.id === item.id ? { ...i, text: value } : i))
            : n.items.filter(i => i.id !== item.id),
        }))
      })
      return h(
        'div',
        { class: `check-item${item.done ? ' done' : ''}` },
        h(
          'button',
          {
            class: `check${item.done ? ' on' : ''}`,
            'aria-label': item.done ? 'Mark not done' : 'Mark done',
            onclick: () =>
              void change(noteId, n => ({
                ...n,
                items: n.items.map(i => (i.id === item.id ? { ...i, done: !i.done } : i)),
              })),
          },
          item.done ? icon('check') : null,
        ),
        text,
        h(
          'button',
          {
            class: 'remove',
            'aria-label': 'Remove item',
            onclick: () =>
              void change(noteId, n => ({ ...n, items: n.items.filter(i => i.id !== item.id) })),
          },
          icon('close'),
        ),
      )
    }),
  )

  const full = note.items.length >= NOTE_MAX_ITEMS
  const addField = h('input', {
    class: 'field',
    placeholder: full ? `Lists hold up to ${NOTE_MAX_ITEMS} items` : 'Add an item',
    maxlength: String(NOTE_ITEM_MAX_CHARS),
    disabled: full,
    'aria-label': 'New item',
  }) as HTMLInputElement
  const add = () => {
    const [clean] = sanitizeItemTexts([addField.value])
    if (!clean) return
    addField.value = ''
    void change(noteId, n =>
      n.items.length >= NOTE_MAX_ITEMS
        ? null
        : { ...n, items: [...n.items, { id: newId(), text: clean, done: false }] },
    ).then(() => document.querySelector<HTMLInputElement>('.add-item .field')?.focus())
  }
  addField.addEventListener('keydown', event => {
    if (event.key === 'Enter') add()
  })

  const done = note.items.filter(i => i.done).length
  const body = h(
    'div',
    {},
    title,
    note.items.length > 0
      ? h('div', { class: 'caption' }, `${done} of ${note.items.length} done`)
      : null,
    h('div', { style: 'height: 12px' }),
    items,
    h(
      'div',
      { class: 'add-item' },
      addField,
      h(
        'button',
        { class: 'send', 'aria-label': 'Add', onclick: add, disabled: full },
        icon('plus'),
      ),
    ),
    h(
      'div',
      { class: 'button-row', style: 'margin-top: 24px' },
      done > 0
        ? h(
            'button',
            {
              class: 'button',
              onclick: () =>
                void change(noteId, n => ({
                  ...n,
                  items: n.items.map(i => ({ ...i, done: false })),
                })),
            },
            'Uncheck all',
          )
        : null,
      h(
        'button',
        {
          class: 'button danger',
          onclick: async () => {
            if (!window.confirm(`Delete "${note.title || 'this list'}"? This cannot be undone.`))
              return
            await notes.remove(noteId)
            cache = null
            toast('List deleted')
            ctx.navigate({ tab: 'notes' }, { replace: true })
          },
        },
        icon('trash'),
        'Delete list',
      ),
    ),
  )

  // A change from the glasses or Jarvis redraws the list - unless a field
  // here is being typed into, which a redraw would throw away; the change
  // shows as soon as that field is left.
  let missed = false
  const redraw = () => {
    cache = null
    if (isTyping()) missed = true
    else ctx.refresh()
  }
  const stop = onNotesChange(redraw)
  const onFocusOut = () => {
    if (missed) {
      missed = false
      setTimeout(() => (isTyping() ? (missed = true) : ctx.refresh()), 0)
    }
  }
  document.addEventListener('focusout', onFocusOut)
  if (!note.title) queueMicrotask(() => title.focus())
  return {
    // The list's own name is the big editable title below.
    title: 'Notes',
    back: { tab: 'notes' },
    body,
    cleanup: () => {
      stop()
      document.removeEventListener('focusout', onFocusOut)
    },
  }
}

export function notesView(ctx: AppContext, route: Route): Page {
  if (route.tab === 'notes' && route.noteId) return notePage(ctx, route.noteId)
  return listPage(ctx)
}
