import { listenOnce, stopListening } from './service'
import { dispatchVoiceCommand } from '../../core/voiceDispatch'
import { setContent } from '../../platform/page'
import type { Tool } from '../../core/tool'

// Push-to-talk: opening the tool IS the push. It starts listening
// immediately, shows one result (what it heard, and what it did with it, or
// an error), then waits for the wearer to double-tap out and reopen to try
// again. An always-listen mode (continuous recognition, watching every
// transcript for a wake phrase) is a real possibility later - per direct
// discussion, its cost depends on whether it ends up running against this
// same browser API or a heavier bundled model, so it stays a separate
// decision rather than a flag bolted onto this one-shot flow now.
//
// Guards a listenOnce() call that is still in flight when the tool closes or
// reopens (leaving mid-listen, or a slow response landing after a fresh
// open already started its own). Each call captures the session id current
// when it started; if that no longer matches by the time it resolves, its
// result is stale and gets dropped instead of overwriting whatever the
// current session is showing.
let sessionId = 0

async function listen() {
  const mySession = ++sessionId
  const result = await listenOnce()
  if (mySession !== sessionId) return

  if (result.kind === 'unavailable') {
    setContent('Speech recognition is not available on this device.')
    return
  }
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
  initialContent: () => 'Listening...',
  onOpen: listen,
  onClose: () => {
    sessionId++
    stopListening()
  },
  onSuspend: () => {
    sessionId++
    stopListening()
  },
}
