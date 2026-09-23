import { notes, scripts, getActiveScriptId, setActiveScriptId, type Item } from './data'
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
  | { kind: 'editor'; collection: Collection; item: Item | null }
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

function store(collection: Collection) {
  return collection === 'scripts' ? scripts : notes
}

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

// --- List (Scripts or Notes) ------------------------------------------------

function itemRow(collection: Collection, item: Item): string {
  const isActive = collection === 'scripts' && item.id === activeScriptId
  const title = escapeHtml(item.title || '(untitled)')
  return `
    <li class="item" data-id="${escapeHtml(item.id)}">
      <div class="item-title">${title}${isActive ? ' <span class="badge">Active</span>' : ''}</div>
      <div class="item-actions">
        ${collection === 'scripts' && !isActive ? '<button class="activate">Use</button>' : ''}
        <button class="edit">Edit</button>
        <button class="delete">Delete</button>
      </div>
    </li>
  `
}

async function renderList(collection: Collection) {
  if (!root) return
  const items = (await store(collection).readAll()).sort((a, b) => b.updatedAt - a.updatedAt)

  root.innerHTML = `
    ${backButton()}
    <button class="add">+ New ${collection === 'scripts' ? 'script' : 'note'}</button>
    <ul class="list">
      ${items.length === 0 ? '<li class="empty">Nothing here yet.</li>' : ''}
      ${items.map(item => itemRow(collection, item)).join('')}
    </ul>
  `

  attachBack({ kind: 'menu' })

  root.querySelector('.add')?.addEventListener('click', () => {
    view = { kind: 'editor', collection, item: null }
    render()
  })

  root.querySelectorAll<HTMLElement>('.item').forEach(el => {
    const id = el.dataset.id
    if (!id) return

    el.querySelector('.edit')?.addEventListener('click', async () => {
      const found = (await store(collection).readAll()).find(i => i.id === id) ?? null
      view = { kind: 'editor', collection, item: found }
      render()
    })

    el.querySelector('.delete')?.addEventListener('click', async () => {
      await store(collection).remove(id)
      if (collection === 'scripts') {
        clearActiveScriptIfCurrent(id)
        if (id === activeScriptId) activeScriptId = null
      }
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

// --- Editor ------------------------------------------------------------

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

function renderEditor(collection: Collection, item: Item | null) {
  if (!root) return
  const showPreview = collection === 'scripts'

  root.innerHTML = `
    ${backButton()}
    <div class="editor">
      <input class="title" type="text" placeholder="Title" value="${escapeHtml(item?.title ?? '')}" />
      <textarea class="body" placeholder="Write here...">${escapeHtml(item?.body ?? '')}</textarea>
      ${showPreview ? glassesPreview(item?.body ?? '') : ''}
      <div class="editor-actions">
        <button class="save">Save</button>
        <button class="cancel">Cancel</button>
      </div>
    </div>
  `

  attachBack({ kind: 'list', collection })

  if (showPreview) {
    const bodyEl = root.querySelector<HTMLTextAreaElement>('.body')
    const screenEl = root.querySelector<HTMLElement>('.glasses-screen')
    bodyEl?.addEventListener('input', () => {
      if (screenEl) screenEl.textContent = bodyEl.value
    })
  }

  root.querySelector('.cancel')?.addEventListener('click', () => {
    view = { kind: 'list', collection }
    render()
  })

  root.querySelector('.save')?.addEventListener('click', async () => {
    const title = (root.querySelector('.title') as HTMLInputElement).value.trim()
    const body = (root.querySelector('.body') as HTMLTextAreaElement).value
    const col = store(collection)

    if (item) {
      await col.update(item.id, title, body)
      if (collection === 'scripts') {
        setActiveScriptContent(item.id, body)
      }
    } else {
      await col.create(title, body)
    }

    view = { kind: 'list', collection }
    render()
  })
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
      renderList(view.collection)
      return
    case 'editor':
      renderEditor(view.collection, view.item)
      return
  }
}

async function init() {
  activeScriptId = await getActiveScriptId()
  render()
}

init()
