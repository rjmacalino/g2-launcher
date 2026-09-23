import { notes as notesStore, NOTE_ITEM_MAX_CHARS, type ChecklistItem, type NoteDoc } from './store'
import { status } from '../../platform/bridge'
import type { Tool } from '../../core/tool'

// A checklist tool, not a text editor. Authoring is phone-only, same as
// Teleprompter's scripts: the glasses have no keyboard, so creating and
// naming lists happens on the companion page. What the glasses add is the
// thing a phone screen is worse at doing hands-free: working through a list
// one item at a time while your hands are busy with whatever the list is
// tracking.
//
// Two levels of its own depth, same shape as Teleprompter's picker/reading
// split: pick which list, then work through its items. Both levels are
// native lists (contentKind is always 'list' here, never 'text'), just
// showing different content depending on depth.
type Depth = 'picker' | 'checklist'
let depth: Depth = 'picker'

// Cached for the current open, refreshed in beforeOpen, same reasoning as
// Teleprompter's pickerScripts: contentKind/listItems/onListSelect are all
// synchronous, so the data has to already be here before they run.
let allNotes: NoteDoc[] = []
let currentNoteId: string | null = null

function currentNote(): NoteDoc | null {
  return allNotes.find(n => n.id === currentNoteId) ?? null
}

// Unchecked items first, in their stored order; done items after. Not
// cosmetic. The firmware always resets a rebuilt list's highlight to index 0
// - the same limitation #7 found for the launcher menu always reopening on
// Weather - so a rebuild after checking something off would normally dump
// the wearer back at the top of an arbitrary list. Sorting this way turns
// that into the thing that makes a checklist actually usable: the item that
// lands at the top after a toggle is always the next thing to do. Working
// through a list in order costs nothing but taps.
function sortedItems(note: NoteDoc): ChecklistItem[] {
  return note.items.filter(i => !i.done).concat(note.items.filter(i => i.done))
}

// No checkbox glyph. Icon rendering on this firmware is unverified - same
// reasoning as the status bar's weather icons - and an unsupported codepoint
// draws a placeholder box, worse than no icon at all. A plain ASCII bracket
// is guaranteed to render.
function formatItemLabel(item: ChecklistItem): string {
  const mark = item.done ? '[x]' : '[ ]'
  // Defensive clamp. The data layer already enforces this on every write, so
  // this should never actually trim anything; kept because this is the one
  // place a violation would break the page (a list item over the platform
  // limit), and trusting an upstream guarantee at the point where a
  // violation is expensive is the wrong place to save a line.
  return `${mark} ${item.text}`.slice(0, NOTE_ITEM_MAX_CHARS)
}

async function refresh(): Promise<void> {
  allNotes = (await notesStore.readAll()).sort((a, b) => b.updatedAt - a.updatedAt)
  depth = 'picker'
  currentNoteId = null
}

export const notesTool: Tool = {
  name: 'Notes',
  confirmOnExit: () => true,
  confirmPrompt: () => (depth === 'checklist' ? 'Leave this list?' : 'Leave Notes?'),
  beforeOpen: refresh,
  contentKind: () => 'list',
  listItems: () => {
    if (depth === 'picker') {
      if (allNotes.length === 0) return ['No lists yet. Add one on your phone.']
      return allNotes.map(n => {
        const done = n.items.filter(i => i.done).length
        const total = n.items.length
        const suffix = total > 0 ? ` (${done}/${total})` : ''
        return `${n.title || '(untitled)'}${suffix}`.slice(0, NOTE_ITEM_MAX_CHARS)
      })
    }
    const note = currentNote()
    if (!note || note.items.length === 0) return ['Nothing on this list yet.']
    return sortedItems(note).map(formatItemLabel)
  },
  onListSelect: index => {
    if (depth === 'picker') {
      const note = allNotes[index]
      // Absent when the picker is showing the empty-state placeholder; a tap
      // on that correctly does nothing.
      if (note) {
        currentNoteId = note.id
        depth = 'checklist'
      }
      return
    }

    // depth === 'checklist'. Mutate the in-memory note SYNCHRONOUSLY: the
    // shell rebuilds immediately after this returns, and listItems() must
    // already reflect the toggle by then, which rules out awaiting the
    // storage write here (onListSelect has to stay synchronous, same
    // constraint as contentKind/listItems/initialContent). The write itself
    // is fired in the background; a failure surfaces through status(), and
    // the wearer's view stays correct either way since it was never waiting
    // on the write to begin with.
    const note = currentNote()
    if (!note) return
    const item = sortedItems(note)[index]
    if (!item) return
    item.done = !item.done
    note.updatedAt = Date.now()
    notesStore.save(note).then(ok => {
      if (!ok) status('Failed to save checklist')
    })
  },
  // Long press resets a checklist's done state, per direct request. No
  // confirmation: this app now confirms every ordinary exit, but a reset is
  // not leaving anything, and a wearer who long-presses by accident loses
  // check marks rather than their place in a script or a live GPS session.
  // Recorded as a deliberate choice, not an oversight - the same "ask if you
  // meant it" reasoning behind every other confirmation in this app would
  // argue for one here too, and this can gain one later if losing progress
  // to a mistimed long press turns out to matter in practice.
  onLongPress: () => {
    if (depth !== 'checklist') return
    const note = currentNote()
    if (!note) return
    for (const item of note.items) item.done = false
    note.updatedAt = Date.now()
    status('List reset')
    notesStore.resetItems(note.id).then(ok => {
      if (!ok) status('Failed to save reset')
    })
  },
  onConfirmedExit: () => {
    if (depth === 'checklist') {
      depth = 'picker'
      currentNoteId = null
      return 'tool'
    }
    return 'menu'
  },
  // Never actually rendered: contentKind is always 'list' for this tool, and
  // initialContent only matters when contentKind is 'text'. Required by the
  // interface regardless, since not every tool has this luxury.
  initialContent: () => '',
}
