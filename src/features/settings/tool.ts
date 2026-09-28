import { getConfig, setField, type StatusBarConfig } from './store'
import type { Tool } from '../../core/tool'

// One toggle per status bar field, in the order the bar itself draws them
// (date, weather, time - see app/statusbar.ts's SLOTS). Nothing to pick
// between beyond that yet: this is the launcher's first Settings screen, not
// a general preferences framework, so it only knows about the one config
// that already existed and had nowhere to be edited (see
// features/settings/store.ts).
const FIELDS: { field: keyof StatusBarConfig; label: string }[] = [
  { field: 'date', label: 'Show date' },
  { field: 'temperature', label: 'Show weather' },
  { field: 'time', label: 'Show time' },
]

// No checkbox glyph, same reasoning as Notes' checklist items: icon
// rendering on this firmware is unverified, and an unsupported codepoint
// draws a placeholder box, worse than no icon at all.
function itemLabel(entry: (typeof FIELDS)[number]): string {
  return `${getConfig()[entry.field] ? '[x]' : '[ ]'} ${entry.label}`
}

export const settingsTool: Tool = {
  name: 'Settings',
  contentKind: () => 'list',
  listItems: () => FIELDS.map(itemLabel),
  // Flips the field and lets the shell's normal post-onListSelect rebuild
  // repaint the list with the new checkmark, same as Notes toggling a
  // checklist item - no separate rebuild request needed here.
  onListSelect: index => {
    const entry = FIELDS[index]
    if (!entry) return
    setField(entry.field, !getConfig()[entry.field])
  },
  // Never actually rendered: contentKind is 'list' whenever this would be
  // used. Required by the interface regardless, same as Notes.
  initialContent: () => '',
}
