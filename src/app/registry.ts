import type { Tool } from '../core/tool'
import { chatTool } from '../features/chat/tool'
import { notesTool } from '../features/notes/tool'
import { liveTool } from '../features/live/tool'
import { LAB_ENABLED, WINGMAN_ENABLED } from '../shared/features'

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
// Wingman (G2-65) is its conversation-listening mode, a launcher entry
// of its own because it is a different thing to open: it listens to the
// conversation around the wearer instead of waiting to be asked. Added
// before Notes rather than after so the two Jarvis entries sit together;
// a stored screen index from before this restores one entry off, which
// app/screen.ts tolerates (see above).
//
// Lab is dev-only, added last so it never shifts a released build's saved
// screen index, and imported behind import.meta.env.DEV so a production
// build tree-shakes the whole features/lab module out rather than merely
// hiding a menu entry that is still sitting in the package.
// Wingman is off the launcher for now (G2-100, shared/features.ts).
const tools: Tool[] = [chatTool, ...(WINGMAN_ENABLED ? [liveTool] : []), notesTool]

if (import.meta.env.DEV && LAB_ENABLED) {
  const { labTool } = await import('../features/lab/tool')
  tools.push(labTool)
}

export const TOOLS: readonly Tool[] = tools

export const TOOL_NAMES: readonly string[] = TOOLS.map(t => t.name)
