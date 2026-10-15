import type { Tool } from '../core/tool'
import { chatTool } from '../features/chat/tool'
import { notesTool } from '../features/notes/tool'

// Order is the index. The firmware reports the highlighted list row back as
// currentSelectItemIndex, and that index is what gets persisted in ui.screen, so
// reordering this array changes what a stored screen restores to. A stored
// index from an older order restores to whatever now sits there, or the menu
// if out of range (app/screen.ts checks the range) - harmless, and only
// within the 30-minute restore window.
//
// Just Jarvis and Notes, per direct request (2026-10-15): the wearer uses
// the status bar's weather instead of the Weather screen, the glasses' own
// native teleprompter instead of this one, and Jarvis for everything else -
// "we will think and add more later". The other tools are off the launcher,
// not deleted: features/weather, features/teleprompter, features/timer and
// features/settings are all still here, and each comes back by adding it to
// this array. Their background parts keep running regardless of the
// launcher - the status bar's weather and timer countdown come from
// features/weather/service.ts and features/timer/service.ts, and its layout
// from features/settings/store.ts, none of which this list controls.
//
// Jarvis (chatTool) is the one assistant - see features/chat/tool.ts.
//
// Lab is dev-only, added last so it never shifts a released build's saved
// screen index, and imported behind import.meta.env.DEV so a production
// build tree-shakes the whole features/lab module out rather than merely
// hiding a menu entry that is still sitting in the package.
const tools: Tool[] = [chatTool, notesTool]

if (import.meta.env.DEV) {
  const { labTool } = await import('../features/lab/tool')
  tools.push(labTool)
}

export const TOOLS: readonly Tool[] = tools

export const TOOL_NAMES: readonly string[] = TOOLS.map(t => t.name)
