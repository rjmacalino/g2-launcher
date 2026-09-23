import { getActiveScriptId, scripts } from '../data'
import type { Tool } from './types'

// The script used to be a hardcoded array in this file. It is now whatever the
// wearer wrote on the phone companion page and marked active, per direct
// request. Line breaks are no longer ours to choose: since G2-19 the firmware
// scrolls the whole body natively, so a user-supplied script wraps to the full
// width on its own.
const FALLBACK_SCRIPT = 'No script loaded.\n\nAdd one on your phone,\nthen mark it active.'

// The single source of truth while the app is running. Reading storage on
// every open would mean an async gap between the page existing and content
// being correct; keeping this in memory means initialContent (which must be
// synchronous, see types.ts) always has the right answer immediately.
//
// The companion editor updates this directly, in the same running JS
// instance, whenever the active script is created, edited, or reassigned. See
// setActiveScriptContent below.
let currentScript = FALLBACK_SCRIPT

async function loadActiveScript(): Promise<void> {
  const id = await getActiveScriptId()
  if (!id) {
    currentScript = FALLBACK_SCRIPT
    return
  }
  const all = await scripts.readAll()
  const found = all.find(s => s.id === id)
  currentScript = found && found.body.trim().length > 0 ? found.body : FALLBACK_SCRIPT
}

// Called by the companion page, not by anything on the glasses side. Keeps the
// in-memory script correct the instant the wearer changes it, rather than
// waiting for the next app restart to pick up a fresh hydrate().
//
// KNOWN LIMITATION: if the active script is edited or deleted while the
// teleprompter is already open and scrolled, the glasses keep showing whatever
// the firmware already rendered. Nothing pushes a mid-read update, on purpose:
// the only way to change displayed content is textContainerUpgrade, and any
// content change resets scroll position, which is the exact failure the leave
// prompt spent five attempts avoiding. The new script takes effect next time
// the tool is opened.
export function setActiveScriptContent(body: string) {
  currentScript = body.trim().length > 0 ? body : FALLBACK_SCRIPT
}

export const teleprompter: Tool = {
  name: 'Teleprompter',
  // Losing your place mid-speech to a mistimed double tap is the failure this
  // guards. Position is not saved (see page.ts for why), so leaving means
  // navigating back by hand, not something to do in front of an audience.
  confirmOnExit: true,
  hydrate: loadActiveScript,
  initialContent: () => currentScript,
}
