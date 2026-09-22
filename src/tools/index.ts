import type { Tool } from './types'
import { gps } from './gps'
import { teleprompter } from './teleprompter'

export type { Tool } from './types'

// A tool with no behaviour yet. Named rather than inlined so that it is obvious
// from the TOOLS array below which entries are real and which are stubs.
function placeholder(name: string): Tool {
  return { name, initialContent: () => name }
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
