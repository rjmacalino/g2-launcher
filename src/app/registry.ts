import type { Tool } from '../core/tool'
import { notesTool } from '../features/notes/tool'
import { teleprompter } from '../features/teleprompter/tool'
import { weatherTool } from '../features/weather/tool'

// Order is the index. The firmware reports the highlighted list row back as
// currentSelectItemIndex, and that index is what gets persisted in ui.screen, so
// reordering this array changes what a stored screen restores to.
//
// No standalone GPS entry. It used to be here as its own tool; per direct
// request it was cut, since nobody used a raw lat/lon readout on its own.
// What GPS actually gave this app - a location fix - still exists, just as
// plumbing Weather calls internally (see platform/location.ts) rather than a page a
// wearer opens on purpose.
export const TOOLS: readonly Tool[] = [weatherTool, notesTool, teleprompter]

export const TOOL_NAMES: readonly string[] = TOOLS.map(t => t.name)
