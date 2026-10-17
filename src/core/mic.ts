import { AudioInputSource } from '@evenrealities/even_hub_sdk'
import { bridge } from '../platform/bridge'

// The one owner of the glasses microphone (G2-64). Several things listen
// at once now - "Hey Jarvis" all the time, a Jarvis recording on top of
// it, Lab's probes - and each used to call audioControl itself, so the
// first one to finish switched the mic off under everyone else. Here the
// mic is on while anyone holds it and off when the last one lets go.
//
// Audio capture stops when the app goes to the background and has to be
// re-armed on return (docs/platform.md, Lifecycle): app/main.ts calls
// micSuspended() and micResumed() around that.

// speaker is the glasses' own guess at who is talking in this frame -
// "self", "other" or "unknown" (the SDK's AudioSpeakerRole). [UNVERIFIED]
// what it reports on hardware.
export type MicListener = (pcm: Uint8Array, speaker: string) => void

const listeners = new Set<MicListener>()
let unsubscribeEvents: (() => void) | null = null
let on = false
let starting: Promise<boolean> | null = null

function deliver(pcm: Uint8Array, speaker: string) {
  for (const listener of listeners) listener(pcm, speaker)
}

function subscribe() {
  if (unsubscribeEvents) return
  unsubscribeEvents = bridge.onEvenHubEvent(event => {
    const audio = event.audioEvent
    if (audio && audio.source === AudioInputSource.Glasses) {
      deliver(audio.audioPcm, String(audio.speakerRole ?? 'unknown'))
    }
  })
}

function switchOn(): Promise<boolean> {
  if (on) return Promise.resolve(true)
  if (!starting) {
    starting = bridge.audioControl(true, AudioInputSource.Glasses).then(ok => {
      starting = null
      // Everyone may have let go while this was in flight.
      if (ok && listeners.size === 0) {
        void bridge.audioControl(false)
        return false
      }
      on = ok
      return ok
    })
  }
  return starting
}

function releaseIfUnused() {
  if (listeners.size > 0) return
  unsubscribeEvents?.()
  unsubscribeEvents = null
  if (on) void bridge.audioControl(false)
  on = false
}

// Resolves to a release function once the mic is on, or null if it could
// not be switched on (the listener is then not kept).
export async function openMic(listener: MicListener): Promise<(() => void) | null> {
  listeners.add(listener)
  subscribe()
  const ok = await switchOn()
  if (!ok || !listeners.has(listener)) {
    listeners.delete(listener)
    releaseIfUnused()
    return null
  }
  let released = false
  return () => {
    if (released) return
    released = true
    listeners.delete(listener)
    releaseIfUnused()
  }
}

export function micSuspended() {
  on = false
}

export function micResumed() {
  if (listeners.size > 0) void switchOn()
}
