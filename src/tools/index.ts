import type { Tool } from './types'
import { gps } from './gps'
import { teleprompter } from './teleprompter'

export type { Tool } from './types'

// A tool with no behaviour yet. Named rather than inlined so that it is obvious
// from the TOOLS array below which entries are real and which are stubs.
//
// confirmOnExit is true even here, per direct request: every tool in this app
// now asks before leaving, including the two with nothing behind them yet.
// The earlier reasoning ("a placeholder protects nothing, so a prompt there
// is friction with no purpose") turned out to be the wrong axis. The
// consistent rule is not "does this tool hold state worth protecting" but
// "does the wearer get a chance to confirm an accidental double tap", and
// that should not depend on how developed the tool is yet.
function placeholder(name: string): Tool {
  return { name, confirmOnExit: () => true, initialContent: () => name }
}

// Order is the index. The firmware reports the highlighted list row back as
// currentSelectItemIndex, and that index is what gets persisted in ui.screen, so
// reordering this array changes what a stored screen restores to.
//
// Weather and Notes are placeholders. Weather needs a proxy, because an API key
// cannot ship inside an extractable package. Notes needs a decision about where
// text comes from on a device with no keyboard.
export const TOOLS: readonly Tool[] = [
  placeholder('Weather'),
  gps,
  placeholder('Notes'),
  teleprompter,
]

export const TOOL_NAMES: readonly string[] = TOOLS.map(t => t.name)
