import { scripts, setActiveScriptId, type Item } from '../data'
import type { Tool } from './types'

// The script used to be a hardcoded array in this file, then whatever was
// marked "active" on the phone. Per direct request, the glasses themselves now
// have their own picker: open Teleprompter, see the saved scripts, tap one to
// load it. Authoring stays phone-only (typing on the glasses is out of scope,
// by choice); choosing which one to read does not have to be.
const FALLBACK_SCRIPT = 'No script loaded.\n\nAdd one on your phone,\nor pick one here.'
const EMPTY_LIST_ITEM = 'No scripts yet. Add one on your phone.'

// 'list' is the picker, 'text' is reading. Names match Tool.contentKind's own
// vocabulary directly rather than a separate picker/reading enum that would
// just need translating at the boundary.
type Mode = 'list' | 'text'
let mode: Mode = 'list'

// Cached for the CURRENT open only, refreshed in beforeOpen (awaited by the
// shell before the page is built, see types.ts) so contentKind, listItems and
// initialContent - all synchronous - have correct data the instant they run.
let pickerScripts: Item[] = []

let currentScript = FALLBACK_SCRIPT
let currentScriptId: string | null = null

async function refresh(): Promise<void> {
  pickerScripts = (await scripts.readAll()).sort((a, b) => b.updatedAt - a.updatedAt)
  // Always reopens to the picker. There is no way to pre-select a specific row
  // in a native list (the firmware itself always defaults highlight to index
  // 0, the same limitation #7 found for the launcher menu), so remembering
  // "the last one" would not even be visible as a highlight, and silently
  // auto-loading straight into reading would contradict the reason the picker
  // exists: choosing is supposed to be a deliberate step, every time.
  mode = 'list'
}

function pickScript(item: Item) {
  currentScriptId = item.id
  currentScript = item.body.trim().length > 0 ? item.body : FALLBACK_SCRIPT
  mode = 'text'
  // Keeps the phone's "Active" badge pointing at whichever script the wearer
  // most recently chose, from either surface. A single shared notion of
  // "active" rather than two that could quietly disagree.
  setActiveScriptId(item.id)
}

// Live-sync entry points for the companion page. Both are guarded by the id
// actually being the one currently on screen, so an edit or delete elsewhere
// in the wearer's library has no visible effect until the tool is reopened.
//
// KNOWN LIMITATION: if the script actually on screen is edited or deleted
// while it is open and the firmware has already scrolled it, the glasses keep
// showing whatever is already rendered there. Nothing pushes a mid-read
// update, on purpose: the only way to change displayed text is
// textContainerUpgrade, and any content change resets the firmware's scroll
// position, which is the exact failure the leave prompt spent five attempts
// avoiding. The change takes effect next time the tool is opened.
export function setActiveScriptContent(id: string, body: string) {
  if (currentScriptId === id) {
    currentScript = body.trim().length > 0 ? body : FALLBACK_SCRIPT
  }
}

export function clearActiveScriptIfCurrent(id: string) {
  if (currentScriptId === id) {
    currentScriptId = null
    currentScript = FALLBACK_SCRIPT
  }
}

export const teleprompter: Tool = {
  name: 'Teleprompter',
  // Always, in both the picker and while reading, per direct request: an
  // accidental double-tap should be double-checked no matter which of the
  // two screens it happens on. Originally the picker was exempt (nothing
  // loaded yet, so nothing to lose), but "did you mean that" turned out to
  // matter more than "is there data at risk" here.
  confirmOnExit: () => true,
  beforeOpen: refresh,
  contentKind: () => mode,
  listItems: () =>
    pickerScripts.length > 0 ? pickerScripts.map(s => s.title || '(untitled)') : [EMPTY_LIST_ITEM],
  onListSelect: index => {
    const item = pickerScripts[index]
    // Absent when the picker is showing the empty-state placeholder instead of
    // a real script; a tap on that placeholder correctly does nothing.
    if (item) pickScript(item)
  },
  // Confirming "leave" backs up exactly one level, matching what "back" means
  // everywhere else in this app: from reading, that is the picker; from the
  // picker itself, there is nowhere shallower left inside this tool, so it
  // means leaving Teleprompter entirely, same as double-tap on the menu.
  //
  // Reads mode AS IT WAS when the double-tap happened, not after: confirming
  // never touches Teleprompter's own state until this fires, so mode still
  // reflects whichever screen the wearer was actually looking at.
  onConfirmedExit: () => {
    if (mode === 'text') {
      mode = 'list'
      return 'tool'
    }
    return 'menu'
  },
  initialContent: () => currentScript,
}
