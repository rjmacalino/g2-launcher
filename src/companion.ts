import {
  notes,
  scripts,
  getActiveScriptId,
  setActiveScriptId,
  NOTE_MAX_ITEMS,
  NOTE_ITEM_MAX_CHARS,
  type Item,
  type NoteDoc,
} from './data'
import { setActiveScriptContent, clearActiveScriptIfCurrent } from './tools/teleprompter'
import { TOOL_NAMES } from './tools'

// The phone companion page: browse the same tools the glasses menu shows, and
// manage the data behind Notes and Teleprompter scripts.
//
// This runs in the SAME JS instance as everything driving the glasses (see
// bridge.ts), not a separate app talking over a network. That is why this
// needs no server: bridge.setLocalStorage is already a persistent per-device
// store, and editing the active script here can update the teleprompter's
// in-memory content directly via setActiveScriptContent, without a round trip
// through storage and a restart to notice.
//
// Rendering is rebuild-the-whole-view-on-every-change. No framework, no
// diffing: the lists here are short (a wearer's own notes and scripts, not a
// feed), so the cost of throwing away and rebuilding the DOM on every action
// is not worth a dependency to avoid.

type Collection = 'scripts' | 'notes'

// Mirrors the shell's own Screen type in main.ts: a small closed set of places
// the wearer can be, driving what render() draws. The top level, 'menu', is a
// deliberate copy of the glasses' own launcher list (same TOOL_NAMES, same
// order), so opening the phone looks like opening the glasses.
type View =
  | { kind: 'menu' }
  | { kind: 'list'; collection: Collection }
  | { kind: 'editor'; collection: 'scripts'; item: Item | null }
  | { kind: 'editor'; collection: 'notes'; item: NoteDoc | null }
  | { kind: 'stub'; label: string }

let view: View = { kind: 'menu' }

// Which script is "active": the one most recently chosen, from either the
// phone's Use button or the glasses' own picker (see teleprompter.ts). Purely
// informational here, the badge shown next to a script in the list. It does
// NOT mean "will load automatically next time the teleprompter opens" - the
// glasses always show their picker first, per direct request, so nothing
// auto-loads any more. This can go stale if the wearer changes it on the
// glasses without ever reopening the phone page in between; accepted, since
// fixing that needs a live channel from the glasses side back to this page,
// and the badge is a convenience, not something anything else depends on.
let activeScriptId: string | null = null

const root = document.getElementById('companion')
if (!root) throw new Error('companion root element missing from index.html')

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function backButton(): string {
  return '<button class="back">&lt; Back</button>'
}

function attachBack(target: View) {
  root?.querySelector('.back')?.addEventListener('click', () => {
    view = target
    render()
  })
}

// --- Menu (mirrors the glasses launcher) -----------------------------------

function renderMenu() {
  if (!root) return
  root.innerHTML = `
    <ul class="list menu-list">
      ${TOOL_NAMES.map(name => `<li class="item menu-item" data-name="${escapeHtml(name)}">${escapeHtml(name)}</li>`).join('')}
    </ul>
  `
  root.querySelectorAll<HTMLElement>('.menu-item').forEach(el => {
    el.addEventListener('click', () => {
      const name = el.dataset.name
      if (name === 'Teleprompter') view = { kind: 'list', collection: 'scripts' }
      else if (name === 'Notes') view = { kind: 'list', collection: 'notes' }
      else view = { kind: 'stub', label: name ?? '' }
      render()
    })
  })
}

// --- Stub (Weather, GPS: nothing to configure yet) -------------------------

function renderStub(label: string) {
  if (!root) return
  root.innerHTML = `
    ${backButton()}
    <div class="stub">
      <div class="stub-title">${escapeHtml(label)}</div>
      <div class="stub-body">Nothing to set up here yet.</div>
    </div>
  `
  attachBack({ kind: 'menu' })
}

// --- List: Scripts ------------------------------------------------------

function scriptRow(item: Item): string {
  const isActive = item.id === activeScriptId
  const title = escapeHtml(item.title || '(untitled)')
  return `
    <li class="item" data-id="${escapeHtml(item.id)}">
      <div class="item-title">${title}${isActive ? ' <span class="badge">Active</span>' : ''}</div>
      <div class="item-actions">
        ${!isActive ? '<button class="activate">Use</button>' : ''}
        <button class="edit">Edit</button>
        <button class="delete">Delete</button>
      </div>
    </li>
  `
}

async function renderScriptsList() {
  if (!root) return
  const items = (await scripts.readAll()).sort((a, b) => b.updatedAt - a.updatedAt)

  root.innerHTML = `
    ${backButton()}
    <button class="add">+ New script</button>
    <ul class="list">
      ${items.length === 0 ? '<li class="empty">Nothing here yet.</li>' : ''}
      ${items.map(scriptRow).join('')}
    </ul>
  `

  attachBack({ kind: 'menu' })

  root.querySelector('.add')?.addEventListener('click', () => {
    view = { kind: 'editor', collection: 'scripts', item: null }
    render()
  })

  root.querySelectorAll<HTMLElement>('.item').forEach(el => {
    const id = el.dataset.id
    if (!id) return

    el.querySelector('.edit')?.addEventListener('click', async () => {
      const found = (await scripts.readAll()).find(i => i.id === id) ?? null
      view = { kind: 'editor', collection: 'scripts', item: found }
      render()
    })

    el.querySelector('.delete')?.addEventListener('click', async () => {
      await scripts.remove(id)
      clearActiveScriptIfCurrent(id)
      if (id === activeScriptId) activeScriptId = null
      render()
    })

    el.querySelector('.activate')?.addEventListener('click', async () => {
      const ok = await setActiveScriptId(id)
      if (!ok) return
      activeScriptId = id
      const found = (await scripts.readAll()).find(i => i.id === id)
      setActiveScriptContent(id, found ? found.body : '')
      render()
    })
  })
}

// --- Editor: Scripts ------------------------------------------------------

// Approximate only. The glasses use a single fixed firmware font (576x288 px,
// monochrome green) whose exact metrics are undocumented; there is no way to
// reproduce it pixel-for-pixel in CSS. This gives a same-shape, same-aspect
// preview so the wearer can sanity-check line breaks and length before
// reading it live, not a guarantee of the exact on-glasses look.
function glassesPreview(body: string): string {
  return `
    <div class="glasses-preview">
      <div class="glasses-screen">${escapeHtml(body)}</div>
      <div class="glasses-caption">Preview - approximate, actual glasses font may differ</div>
    </div>
  `
}

function renderScriptsEditor(item: Item | null) {
  if (!root) return

  root.innerHTML = `
    ${backButton()}
    <div class="editor">
      <input class="title" type="text" placeholder="Title" value="${escapeHtml(item?.title ?? '')}" />
      <textarea class="body" placeholder="Write here...">${escapeHtml(item?.body ?? '')}</textarea>
      ${glassesPreview(item?.body ?? '')}
      <div class="editor-actions">
        <button class="save">Save</button>
        <button class="cancel">Cancel</button>
      </div>
    </div>
  `

  attachBack({ kind: 'list', collection: 'scripts' })

  const bodyEl = root.querySelector<HTMLTextAreaElement>('.body')
  const screenEl = root.querySelector<HTMLElement>('.glasses-screen')
  bodyEl?.addEventListener('input', () => {
    if (screenEl) screenEl.textContent = bodyEl.value
  })

  root.querySelector('.cancel')?.addEventListener('click', () => {
    view = { kind: 'list', collection: 'scripts' }
    render()
  })

  root.querySelector('.save')?.addEventListener('click', async () => {
    const title = (root.querySelector('.title') as HTMLInputElement).value.trim()
    const body = (root.querySelector('.body') as HTMLTextAreaElement).value

    if (item) {
      await scripts.update(item.id, title, body)
      setActiveScriptContent(item.id, body)
    } else {
      await scripts.create(title, body)
    }

    view = { kind: 'list', collection: 'scripts' }
    render()
  })
}

// --- List: Notes ------------------------------------------------------

// A note's checklist state is meant to be worked through on the glasses (see
// tools/notes.ts): that is the point of a hands-free device. The phone's job
// is authoring the list and, occasionally, clearing it back to a fresh start
// before the wearer heads out again - not ticking items off one at a time,
// which a touchscreen does no better than the glasses do.
function noteRow(note: NoteDoc): string {
  const done = note.items.filter(i => i.done).length
  const total = note.items.length
  const title = escapeHtml(note.title || '(untitled)')
  const progress = total > 0 ? ` <span class="badge">${done}/${total}</span>` : ''
  return `
    <li class="item" data-id="${escapeHtml(note.id)}">
      <div class="item-title">${title}${progress}</div>
      <div class="item-actions">
        ${done > 0 ? '<button class="reset">Reset</button>' : ''}
        <button class="edit">Edit</button>
        <button class="delete">Delete</button>
      </div>
    </li>
  `
}

async function renderNotesList() {
  if (!root) return
  const items = (await notes.readAll()).sort((a, b) => b.updatedAt - a.updatedAt)

  root.innerHTML = `
    ${backButton()}
    <button class="add">+ New note</button>
    <ul class="list">
      ${items.length === 0 ? '<li class="empty">Nothing here yet.</li>' : ''}
      ${items.map(noteRow).join('')}
    </ul>
  `

  attachBack({ kind: 'menu' })

  root.querySelector('.add')?.addEventListener('click', () => {
    view = { kind: 'editor', collection: 'notes', item: null }
    render()
  })

  root.querySelectorAll<HTMLElement>('.item').forEach(el => {
    const id = el.dataset.id
    if (!id) return

    el.querySelector('.edit')?.addEventListener('click', async () => {
      const found = (await notes.readAll()).find(n => n.id === id) ?? null
      view = { kind: 'editor', collection: 'notes', item: found }
      render()
    })

    el.querySelector('.delete')?.addEventListener('click', async () => {
      await notes.remove(id)
      render()
    })

    el.querySelector('.reset')?.addEventListener('click', async () => {
      await notes.resetItems(id)
      render()
    })
  })
}

// --- Editor: Notes ------------------------------------------------------

function renderNotesEditor(item: NoteDoc | null) {
  if (!root) return

  // Draft state for this editing session. Held here rather than read back out
  // of the DOM on save, because a row can be added or removed, which redraws
  // the whole item list; the title and every row's current text have to
  // survive that redraw, so they live in this closure instead of only in the
  // inputs themselves.
  let draftTitle = item?.title ?? ''
  let draftTexts: string[] = item && item.items.length > 0 ? item.items.map(i => i.text) : ['']

  function itemRowHtml(text: string, index: number): string {
    return `
      <li class="note-item-row" data-index="${index}">
        <input
          type="text"
          class="item-text"
          placeholder="Item"
          maxlength="${NOTE_ITEM_MAX_CHARS}"
          value="${escapeHtml(text)}"
        />
        <button class="item-remove" type="button">Remove</button>
      </li>
    `
  }

  function draw() {
    if (!root) return
    root.innerHTML = `
      ${backButton()}
      <div class="editor notes-editor">
        <input class="title" type="text" placeholder="Title" value="${escapeHtml(draftTitle)}" />
        <ul class="note-items">
          ${draftTexts.map((text, i) => itemRowHtml(text, i)).join('')}
        </ul>
        <button class="add-item" type="button" ${draftTexts.length >= NOTE_MAX_ITEMS ? 'disabled' : ''}>
          + Add item
        </button>
        <div class="editor-actions">
          <button class="save">Save</button>
          <button class="cancel">Cancel</button>
        </div>
      </div>
    `

    attachBack({ kind: 'list', collection: 'notes' })

    const titleEl = root.querySelector<HTMLInputElement>('.title')
    titleEl?.addEventListener('input', () => {
      draftTitle = titleEl.value
    })

    root.querySelectorAll<HTMLElement>('.note-item-row').forEach(rowEl => {
      const index = Number(rowEl.dataset.index)
      const textEl = rowEl.querySelector<HTMLInputElement>('.item-text')
      textEl?.addEventListener('input', () => {
        draftTexts[index] = textEl.value
      })
      rowEl.querySelector('.item-remove')?.addEventListener('click', () => {
        draftTexts.splice(index, 1)
        draw()
      })
    })

    root.querySelector('.add-item')?.addEventListener('click', () => {
      if (draftTexts.length >= NOTE_MAX_ITEMS) return
      draftTexts.push('')
      draw()
    })

    root.querySelector('.cancel')?.addEventListener('click', () => {
      view = { kind: 'list', collection: 'notes' }
      render()
    })

    root.querySelector('.save')?.addEventListener('click', async () => {
      const title = draftTitle.trim()
      if (item) {
        await notes.update(item.id, title, draftTexts)
      } else {
        await notes.create(title, draftTexts)
      }
      view = { kind: 'list', collection: 'notes' }
      render()
    })
  }

  draw()
}

// --- Dispatch ----------------------------------------------------------

function render() {
  switch (view.kind) {
    case 'menu':
      renderMenu()
      return
    case 'stub':
      renderStub(view.label)
      return
    case 'list':
      if (view.collection === 'scripts') renderScriptsList()
      else renderNotesList()
      return
    case 'editor':
      if (view.collection === 'scripts') renderScriptsEditor(view.item)
      else renderNotesEditor(view.item)
      return
  }
}

async function init() {
  activeScriptId = await getActiveScriptId()
  render()
}

init()
