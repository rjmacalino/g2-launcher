import { notes, scripts, getActiveScriptId, setActiveScriptId, type Item } from './data'
import { setActiveScriptContent } from './tools/teleprompter'

// The phone companion page: CRUD for notes and teleprompter scripts.
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

const root = document.getElementById('companion')
if (!root) throw new Error('companion root element missing from index.html')

let activeTab: Collection = 'scripts'
let editing: { collection: Collection; item: Item | null } | null = null
let activeScriptId: string | null = null

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

function itemRow(item: Item): string {
  const isActive = activeTab === 'scripts' && item.id === activeScriptId
  const title = escapeHtml(item.title || '(untitled)')
  return `
    <li class="item" data-id="${escapeHtml(item.id)}">
      <div class="item-title">${title}${isActive ? ' <span class="badge">Active</span>' : ''}</div>
      <div class="item-actions">
        ${activeTab === 'scripts' && !isActive ? '<button class="activate">Use</button>' : ''}
        <button class="edit">Edit</button>
        <button class="delete">Delete</button>
      </div>
    </li>
  `
}

async function render() {
  if (editing) {
    renderEditor()
    return
  }
  if (!root) return

  const items = (await store(activeTab).readAll()).sort((a, b) => b.updatedAt - a.updatedAt)

  root.innerHTML = `
    <div class="tabs">
      <button data-tab="scripts" class="${activeTab === 'scripts' ? 'active' : ''}">Scripts</button>
      <button data-tab="notes" class="${activeTab === 'notes' ? 'active' : ''}">Notes</button>
    </div>
    <button class="add">+ New ${activeTab === 'scripts' ? 'script' : 'note'}</button>
    <ul class="list">
      ${items.length === 0 ? '<li class="empty">Nothing here yet.</li>' : ''}
      ${items.map(itemRow).join('')}
    </ul>
  `

  root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab === 'notes' ? 'notes' : 'scripts'
      render()
    })
  })

  root.querySelector('.add')?.addEventListener('click', () => {
    editing = { collection: activeTab, item: null }
    render()
  })

  root.querySelectorAll<HTMLElement>('.item').forEach(el => {
    const id = el.dataset.id
    if (!id) return

    el.querySelector('.edit')?.addEventListener('click', async () => {
      const found = (await store(activeTab).readAll()).find(i => i.id === id) ?? null
      editing = { collection: activeTab, item: found }
      render()
    })

    el.querySelector('.delete')?.addEventListener('click', async () => {
      await store(activeTab).remove(id)
      if (activeTab === 'scripts' && id === activeScriptId) {
        activeScriptId = null
        setActiveScriptContent('')
      }
      render()
    })

    el.querySelector('.activate')?.addEventListener('click', async () => {
      const ok = await setActiveScriptId(id)
      if (!ok) return
      activeScriptId = id
      const found = (await scripts.readAll()).find(i => i.id === id)
      setActiveScriptContent(found ? found.body : '')
      render()
    })
  })
}

function renderEditor() {
  if (!editing || !root) return
  const { item } = editing

  root.innerHTML = `
    <div class="editor">
      <input class="title" type="text" placeholder="Title" value="${escapeHtml(item?.title ?? '')}" />
      <textarea class="body" placeholder="Write here...">${escapeHtml(item?.body ?? '')}</textarea>
      <div class="editor-actions">
        <button class="save">Save</button>
        <button class="cancel">Cancel</button>
      </div>
    </div>
  `

  root.querySelector('.cancel')?.addEventListener('click', () => {
    editing = null
    render()
  })

  root.querySelector('.save')?.addEventListener('click', async () => {
    if (!editing || !root) return
    const title = (root.querySelector('.title') as HTMLInputElement).value.trim()
    const body = (root.querySelector('.body') as HTMLTextAreaElement).value
    const col = store(editing.collection)

    if (editing.item) {
      await col.update(editing.item.id, title, body)
      // The active script's body can change without its id changing (an edit,
      // not a reassignment). If the wearer is editing the one currently
      // loaded, the teleprompter's in-memory copy has to follow, or the next
      // "Use" press would be the only way to see the edit take effect.
      if (editing.collection === 'scripts' && editing.item.id === activeScriptId) {
        setActiveScriptContent(body)
      }
    } else {
      await col.create(title, body)
    }

    editing = null
    render()
  })
}

async function init() {
  activeScriptId = await getActiveScriptId()
  await render()
}

init()
