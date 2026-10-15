import {
  notes,
  onNotesChange,
  NOTE_MAX_ITEMS,
  NOTE_ITEM_MAX_CHARS,
  type NoteDoc,
} from '../features/notes/store'
import {
  scripts,
  getActiveScriptId,
  setActiveScriptId,
  type Script,
} from '../features/teleprompter/store'
import { setActiveScriptContent, clearActiveScriptIfCurrent } from '../features/teleprompter/tool'
import {
  getApiKey as getGeminiApiKey,
  setApiKey as setGeminiApiKey,
  getAboutMe,
  setAboutMe,
  ABOUT_ME_MAX_CHARS,
} from '../core/geminiSettings'
import { chatSessions, type ChatSession } from '../features/chat/store'
import { type ChatScreenDetail } from '../features/chat/tool'
import { onCurrentScreenChange, getCurrentScreen } from '../core/currentScreen'
import { TOOL_NAMES } from '../app/registry'

// The phone companion page: browse the same tools the glasses menu shows, and
// manage the data behind Notes and Teleprompter scripts.
//
// This runs in the SAME JS instance as everything driving the glasses (see
// platform/bridge.ts), not a separate app talking over a network. That is why this
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

// Mirrors the shell's own Screen type in app/main.ts: a small closed set of places
// the wearer can be, driving what render() draws. The top level, 'menu', is a
// deliberate copy of the glasses' own launcher list (same TOOL_NAMES, same
// order), so opening the phone looks like opening the glasses.
type View =
  | { kind: 'menu' }
  | { kind: 'list'; collection: Collection }
  | { kind: 'editor'; collection: 'scripts'; item: Script | null }
  | { kind: 'editor'; collection: 'notes'; item: NoteDoc | null }
  | { kind: 'jarvis-settings' }
  | { kind: 'chat-list' }
  | { kind: 'chat-view'; session: ChatSession }
  | { kind: 'stub'; label: string }

let view: View = { kind: 'menu' }

// Which script is "active": the one most recently chosen, from either the
// phone's Use button or the glasses' own picker (see features/teleprompter/tool.ts). Purely
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
      view = baselineViewForTool(el.dataset.name)
      render()
    })
  })
}

// The plain, detail-free mapping from a tool's name to its companion page -
// what clicking a row in the companion's OWN menu uses (no glasses detail
// to go on, just "open this tool's page"), and the fallback the
// glasses-follow sync below uses for every tool except Jarvis, which has
// its own richer, async-aware version (see syncToGlassesScreen). Jarvis's
// page is its conversation list, which links to the Gemini key and About
// You settings.
function baselineViewForTool(name: string | undefined): View {
  if (name === 'Teleprompter') return { kind: 'list', collection: 'scripts' }
  if (name === 'Notes') return { kind: 'list', collection: 'notes' }
  if (name === 'Jarvis') return { kind: 'chat-list' }
  return { kind: 'stub', label: name ?? '' }
}

// Keeps the companion following wherever the glasses actually are - per
// direct instruction, the glasses are the hands-free extension of the
// companion, not a separate app with its own independent place to be, so
// whichever app is open on the glasses, the companion should show that
// same app's (richer) page. One-directional for now: the companion follows
// the glasses, not the other way around - see docs/roadmap.md for the
// companion-steers-glasses direction, not built yet.
//
// Jarvis is the one tool with a richer sync today: its own detail (see
// features/chat/tool.ts's ChatScreenDetail) says not just "Jarvis is open"
// but which depth and which conversation, so the companion can jump
// straight to reading the live conversation instead of always landing on
// the list. Every other tool only gets the baseline "this tool's page is
// open" sync, since none of them publish anything richer yet.
async function syncToGlassesScreen(): Promise<void> {
  const screen = getCurrentScreen()
  if (screen.kind === 'menu') {
    view = { kind: 'menu' }
    render()
    return
  }

  if (screen.name === 'Jarvis') {
    const detail = screen.detail as ChatScreenDetail | undefined
    if (detail?.depth === 'conversation' && detail.sessionId) {
      const found = (await chatSessions.readAll()).find(s => s.id === detail.sessionId)
      view = found ? { kind: 'chat-view', session: found } : { kind: 'chat-list' }
    } else {
      view = { kind: 'chat-list' }
    }
    render()
    return
  }

  view = baselineViewForTool(screen.name)
  render()
}

// --- Gemini settings (shared by Jarvis and Chat) ---------------------------

// A key entered here is never bundled in the build - it is read at runtime
// off this device's own local storage (see core/geminiSettings.ts), the
// same way an API key ships in any app that calls a paid or rate-limited
// third-party service: brought by the wearer, not shipped in the package
// for anyone who downloads it to find. Both Jarvis (its open-ended-question
// fallback) and Chat (every question) use the same key, so both menu items
// route here rather than each growing its own copy of this screen.
// Confirms the save actually round-tripped rather than trusting that
// setLocalStorage's own `ok` result means the value is really readable back
// - per direct report, a key entered here was not being found by Jarvis
// later, with no error visible anywhere to explain why. Re-reading
// immediately after writing turns "did this actually work" into something
// visible on the phone screen instead of something only debuggable with
// devtools, which real hardware does not have an easy way to reach.
async function renderJarvisSettings(statusMessage?: string) {
  if (!root) return
  const existingKey = await getGeminiApiKey()
  const existingAboutMe = await getAboutMe()

  root.innerHTML = `
    ${backButton()}
    <div class="editor jarvis-settings">
      <p class="stub-body">
        Jarvis answers a question it does not recognise as a command
        (like "timer 5 minutes") by asking Google's Gemini API. This needs
        your own free API key from
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com</a>.
        Leave this blank and Jarvis still works for commands, it just will
        not answer open-ended questions.
      </p>
      ${statusMessage ? `<p class="jarvis-settings-status">${escapeHtml(statusMessage)}</p>` : ''}
      <input
        class="title gemini-key"
        type="password"
        placeholder="Gemini API key"
        value="${escapeHtml(existingKey ?? '')}"
      />
      <div class="editor-actions">
        <button class="save">Save</button>
        <button class="cancel clear">Clear</button>
      </div>
      <p class="stub-body">
        A sentence or two about you, sent along with every question to
        Jarvis so answers can actually be tailored to you -
        who you are, what you're working on, how you like answers given.
        Not required; leave it blank and nothing changes about how either
        one answers.
      </p>
      <textarea
        class="body about-me"
        placeholder="e.g. I'm a backend engineer learning web dev from scratch - keep explanations simple, skip the basics I already know."
        maxlength="${ABOUT_ME_MAX_CHARS}"
      >${escapeHtml(existingAboutMe ?? '')}</textarea>
      <div class="editor-actions">
        <button class="save-about-me">Save</button>
        <button class="cancel clear-about-me">Clear</button>
      </div>
    </div>
  `

  // Reached from Jarvis's conversation list (its settings link), so Back
  // returns there.
  attachBack({ kind: 'chat-list' })

  root.querySelector('.save')?.addEventListener('click', async () => {
    const input = root.querySelector<HTMLInputElement>('.gemini-key')
    if (!input) return
    const typed = input.value.trim()
    const wroteOk = await setGeminiApiKey(typed)
    const readBack = await getGeminiApiKey()
    if (!wroteOk) {
      await renderJarvisSettings('Save failed - the device rejected the write. Try again.')
    } else if (typed.length > 0 && readBack !== typed) {
      await renderJarvisSettings(
        "Saved, but reading it back did not match what you typed - Jarvis likely won't find it. Try again, or report this.",
      )
    } else if (typed.length > 0) {
      await renderJarvisSettings(`Saved and confirmed (${readBack?.length ?? 0} characters).`)
    } else {
      await renderJarvisSettings('Cleared.')
    }
  })

  root.querySelector('.clear')?.addEventListener('click', async () => {
    await setGeminiApiKey('')
    await renderJarvisSettings('Cleared.')
  })

  root.querySelector('.save-about-me')?.addEventListener('click', async () => {
    const textarea = root.querySelector<HTMLTextAreaElement>('.about-me')
    if (!textarea) return
    const typed = textarea.value.trim()
    const ok = await setAboutMe(typed)
    await renderJarvisSettings(
      ok
        ? typed.length > 0
          ? 'About You saved.'
          : 'About You cleared.'
        : 'Save failed - try again.',
    )
  })

  root.querySelector('.clear-about-me')?.addEventListener('click', async () => {
    await setAboutMe('')
    await renderJarvisSettings('About You cleared.')
  })
}

// --- Chat (companion is the full-capability side of this tool) ------------
//
// The glasses' own Chat screen can only ever show one "page" of a
// conversation at a time, newest message first, because that display has no
// programmatic scroll (see features/chat/tool.ts). The companion has no
// such limit - a real browser view with normal scrolling - so this is where
// a conversation is actually read end to end, in the order it was spoken,
// and where old sessions get cleaned up. The glasses stay the quick way to
// ask a new question hands-free; the phone is the better way to read what
// came back.

function formatWhen(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

// Matches the glasses' own currently-open conversation, if any (see
// core/currentScreen.ts and features/chat/tool.ts's ChatScreenDetail) -
// this is what lets the picker point out which session is live right now,
// a direct payoff of the glasses-to-companion sync built earlier.
function isLiveOnGlasses(sessionId: string): boolean {
  const screen = getCurrentScreen()
  if (screen.kind !== 'tool' || screen.name !== 'Jarvis') return false
  const detail = screen.detail as ChatScreenDetail | undefined
  return detail?.depth === 'conversation' && detail.sessionId === sessionId
}

function chatRow(session: ChatSession): string {
  const title = escapeHtml(session.title || '(untitled)')
  const count = session.messages.length
  const live = isLiveOnGlasses(session.id)
  return `
    <li class="item" data-id="${escapeHtml(session.id)}" data-title="${title}">
      <div class="item-title">${title}${live ? ' <span class="badge">Live on glasses</span>' : ''}</div>
      <div class="item-sub">${count} message${count === 1 ? '' : 's'} - ${formatWhen(session.updatedAt)}</div>
      <div class="item-actions">
        <button class="open">Open</button>
        <button class="delete">Delete</button>
      </div>
    </li>
  `
}

async function renderChatList() {
  if (!root) return
  const items = (await chatSessions.readAll()).sort((a, b) => b.updatedAt - a.updatedAt)

  root.innerHTML = `
    ${backButton()}
    <p class="stub-body">
      Full conversations, easier to read here than on the glasses.
      <a class="gemini-settings-link" href="#">Gemini API key settings</a>
    </p>
    <ul class="list">
      ${items.length === 0 ? '<li class="empty">No conversations yet. Long-press on the glasses, from any screen, to ask Jarvis something.</li>' : ''}
      ${items.map(chatRow).join('')}
    </ul>
  `

  attachBack({ kind: 'menu' })

  root.querySelector('.gemini-settings-link')?.addEventListener('click', e => {
    e.preventDefault()
    view = { kind: 'jarvis-settings' }
    render()
  })

  root.querySelectorAll<HTMLElement>('.item').forEach(el => {
    const id = el.dataset.id
    if (!id) return

    el.querySelector('.open')?.addEventListener('click', async () => {
      const found = (await chatSessions.readAll()).find(s => s.id === id)
      if (!found) return
      view = { kind: 'chat-view', session: found }
      render()
    })

    // Deleting a conversation is permanent and, unlike Notes or Scripts,
    // this is the ONLY place it can happen at all - the glasses never get
    // a delete gesture for Chat (see docs/roadmap.md principle 5, it would
    // collide with the long-press-to-ask gesture there). One accidental
    // tap here loses history nowhere else can recover, which is worth a
    // native confirm() for - no custom dialog needed, the companion is
    // already a real browser.
    el.querySelector('.delete')?.addEventListener('click', async () => {
      const title = el.dataset.title || 'this conversation'
      if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return
      await chatSessions.remove(id)
      render()
    })
  })
}

function chatBubble(message: ChatSession['messages'][number]): string {
  const who = message.role === 'user' ? 'You' : 'Jarvis'
  return `
    <div class="chat-bubble chat-bubble-${message.role}">
      <div class="chat-bubble-who">${who} - ${formatWhen(message.timestamp)}</div>
      <div class="chat-bubble-text">${escapeHtml(message.text)}</div>
    </div>
  `
}

function renderChatView(session: ChatSession) {
  if (!root) return

  root.innerHTML = `
    ${backButton()}
    <div class="chat-transcript">
      <div class="chat-transcript-title">${escapeHtml(session.title || '(untitled)')}</div>
      ${session.messages.map(chatBubble).join('')}
    </div>
    <div class="editor-actions">
      <button class="delete">Delete this conversation</button>
    </div>
  `

  // Opens on the newest message, not the oldest - the glasses screen
  // already shows the latest exchange by default (see
  // features/chat/tool.ts's own newest-first reasoning); the companion's
  // full, oldest-first transcript should land the reader in the same
  // place, not make them scroll down through everything first. #companion
  // (this element) is the actual scroll container - see index.html's
  // overflow-y: auto on it, not body.
  root.scrollTop = root.scrollHeight

  attachBack({ kind: 'chat-list' })

  // Same reasoning as the picker's own delete (see chatRow above) - this
  // is permanent, and the glasses have no equivalent action to fall back
  // on, so a confirm is worth the one extra tap.
  root.querySelector('.delete')?.addEventListener('click', async () => {
    if (!window.confirm(`Delete "${session.title || 'this conversation'}"? This cannot be undone.`))
      return
    await chatSessions.remove(session.id)
    view = { kind: 'chat-list' }
    render()
  })
}

// --- Stub (any tool with nothing to configure on the phone) ----------------

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

function scriptRow(item: Script): string {
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

function renderScriptsEditor(item: Script | null) {
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
// features/notes/tool.ts): that is the point of a hands-free device. The phone's job
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
  const draftTexts: string[] = item && item.items.length > 0 ? item.items.map(i => i.text) : ['']

  function itemRowHtml(text: string, index: number): string {
    return `
      <li class="note-item-row" data-index="${index}">
        <input
          type="text"
          class="item-text"
          placeholder="Script"
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
    case 'jarvis-settings':
      renderJarvisSettings()
      return
    case 'chat-list':
      renderChatList()
      return
    case 'chat-view':
      renderChatView(view.session)
      return
  }
}

async function init() {
  activeScriptId = await getActiveScriptId()
  // Subscribes for every future glasses navigation, then syncs once to
  // whatever the glasses are showing right now - covers both "the glasses
  // already moved before this page loaded" and "they move after".
  onCurrentScreenChange(() => {
    syncToGlassesScreen()
  })
  // A list changed somewhere else - most often Jarvis adding to it by
  // voice. Redrawn only on the notes list itself: an open editor holds the
  // wearer's unsaved typing, which a redraw would throw away.
  onNotesChange(() => {
    if (view.kind === 'list' && view.collection === 'notes') void renderNotesList()
  })
  await syncToGlassesScreen()
}

init()
