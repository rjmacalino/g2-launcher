import { cancel, start, stop } from './service'
import { dispatchVoiceCommand } from '../../core/voiceDispatch'
import { setContent } from '../../platform/page'
import type { Tool } from '../../core/tool'

// No longer a plain push-to-talk tool the wearer navigates into: the shell
// (app/main.ts) reserves the SDK's LONG_PRESS_EVENT globally to reach Jarvis
// from ANY screen, not only when this tool's own page is already open. This
// file still defines the tool itself - what the page shows, and what
// onOpen/onClose do - but starting and ending a recording now happen through
// beginListening() (called from onOpen) and finishListening() (called
// directly by the shell on a double-press while Jarvis is actively
// listening - see isListening below), rather than through Tool.onLongPress,
// which the shell no longer routes to any tool at all (see the Notes reset
// menu item for where its own long-press use moved once plain long-press
// became Jarvis's globally). Ending on release was tried first and dropped -
// per direct report, holding the whole time a command was spoken meant
// releasing ended the recording too early. Long press now only starts it;
// the wearer is free to let go immediately. No live interim captions either
// - a second real-hardware report found neither captions nor the
// double-press worked reliably while they were running, most likely because
// repeatedly re-transcribing on the main thread blocked event processing.
// See service.ts for the full reasoning; this is back to one clean
// transcription at the end, the shape already confirmed working on real
// hardware.
//
// Guards a session still in flight when the tool closes, reopens, or the
// safety timeout fires. Each call captures the session id current when it
// started; if that no longer matches by the time it resolves, the result is
// stale and gets dropped instead of overwriting whatever the current
// session is showing.
let sessionId = 0

// True only between a recording actually starting and it actually ending
// (success, error, or abandonment) - not "Jarvis is the active screen",
// which is also true while a finished result is just sitting on screen
// waiting for the auto-return. The shell checks this before deciding what a
// double-press means (see app/main.ts): while genuinely listening, a
// double-press ends it; once a result is already showing, or if the
// microphone never even started, a double-press should behave like leaving
// any other tool, not try to stop a recording that has already stopped.
// Missing this distinction meant a wearer restored into a stuck session
// (see the cold-start persistence fix in app/main.ts) had no way out at all
// - every double-press just re-ran an already-finished session instead of
// exiting [HW].
let listening = false

export function isListening(): boolean {
  return listening
}

const doneListeners = new Set<() => void>()

// The shell subscribes once at startup to know when a Jarvis session has
// finished (success, error, or abandoned) so it can auto-return to whatever
// screen was active before the wearer long-pressed. Jarvis itself has no
// notion of "where I was opened from" - that is shell state - so this is
// just a signal, not a payload.
export function onDone(fn: () => void): () => void {
  doneListeners.add(fn)
  return () => doneListeners.delete(fn)
}

function notifyDone() {
  for (const fn of doneListeners) fn()
}

// Starts capturing the moment the page is on screen - called from onOpen
// (normal navigation into Jarvis, or the shell's global long-press handler
// once it has rebuilt into this page).
async function beginListening() {
  const mySession = ++sessionId
  listening = true
  const ok = await start(() => {
    if (mySession !== sessionId) return
    finishListening()
  })
  if (mySession !== sessionId) return
  if (!ok) {
    listening = false
    setContent('Could not start the glasses microphone.')
    notifyDone()
  }
}

// Ends the current recording and dispatches whatever it heard. Called by
// the shell on a double-press while Jarvis is actively listening, and by the
// safety timeout above if the wearer never double-presses at all.
export async function finishListening() {
  const mySession = sessionId
  listening = false
  const result = await stop()
  if (mySession !== sessionId) {
    notifyDone()
    return
  }
  if (result.kind === 'error') {
    setContent(`Didn't catch that (${result.message}).`)
    notifyDone()
    return
  }
  const dispatch = await dispatchVoiceCommand(result.transcript)
  if (mySession !== sessionId) {
    notifyDone()
    return
  }
  const outcome = dispatch.handled ? dispatch.message : "Didn't recognize a command."
  setContent(`Heard: "${result.transcript}"\n\n${outcome}`)
  notifyDone()
}

export const jarvisTool: Tool = {
  name: 'Jarvis',
  contentKind: () => 'text',
  initialContent: () => 'Listening...\n\n(double-press when done)',
  onOpen: beginListening,
  onClose: () => {
    sessionId++
    listening = false
    cancel()
  },
  onSuspend: () => {
    sessionId++
    listening = false
    cancel()
  },
}
