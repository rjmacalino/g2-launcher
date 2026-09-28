import { cancel, recordAndTranscribe, stopNow } from './service'
import { dispatchVoiceCommand } from '../../core/voiceDispatch'
import { setContent } from '../../platform/page'
import type { Tool } from '../../core/tool'

// Push-to-talk: opening the tool IS the push. It starts recording from the
// glasses mic immediately, a long-press ends it early (the one free gesture
// on a text page - see core/tool.ts's onLongPress), or it stops on its own
// after service.ts's MAX_RECORD_MS. Then it shows one result (what it
// heard, and what it did with it, or an error), and waits for the wearer to
// double-tap out and reopen to try again.
//
// An always-listen mode (continuous recognition, watching every transcript
// for a wake phrase) is a real possibility later, but continuous Whisper
// inference is a much bigger battery/complexity cost than one-shot
// push-to-talk, and is not worth building before this simpler version is
// confirmed working well on real hardware.
//
// Guards a recordAndTranscribe() call still in flight when the tool closes
// or reopens. Each call captures the session id current when it started; if
// that no longer matches by the time it resolves, the result is stale and
// gets dropped instead of overwriting whatever the current session shows.
let sessionId = 0

async function listen() {
  const mySession = ++sessionId
  const result = await recordAndTranscribe()
  if (mySession !== sessionId) return

  if (result.kind === 'error') {
    setContent(`Didn't catch that (${result.message}).\n\nDouble-tap, then reopen to try again.`)
    return
  }

  const dispatch = dispatchVoiceCommand(result.transcript)
  const outcome = dispatch.handled ? dispatch.message : "Didn't recognize a command."
  setContent(`Heard: "${result.transcript}"\n\n${outcome}\n\nDouble-tap, then reopen to try again.`)
}

export const jarvisTool: Tool = {
  name: 'Jarvis',
  contentKind: () => 'text',
  initialContent: () => 'Listening... (long-press when done)',
  onOpen: listen,
  onLongPress: stopNow,
  onClose: () => {
    sessionId++
    cancel()
  },
  onSuspend: () => {
    sessionId++
    cancel()
  },
}
