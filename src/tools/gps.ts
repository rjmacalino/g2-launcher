import { AppLocationAccuracy, type AppLocation } from '@evenrealities/even_hub_sdk'
import { bridge, status } from '../bridge'
import { setContent } from '../page'
import type { Tool } from './types'

// The first tool that asks the platform for something. Three concerns the
// teleprompter never had:
//
//   - A declared permission in app.json. The host prompts on first use, and the
//     wearer can refuse. We cannot observe refusal directly.
//   - Data arriving after the page is already on screen. The page renders
//     "Acquiring location..." immediately, before any fix exists.
//   - A resource that runs until stopped. stopAppLocationUpdates stops the HOST
//     sending; the unsubscribe returned by onAppLocationChanged only stops US
//     receiving. Both are needed. Dropping either one looks clean from the side
//     you kept, which is why a leak here is invisible: no error, no task manager,
//     just battery the wearer notices weeks later.
//
// Continuous rather than one-shot. A one-shot read has no subscription to stop,
// which would make the lifecycle question disappear rather than answer it, and
// the GPS page is meant to keep up with a wearer who is moving.
//
// Accuracy is Low on purpose. This is a launcher on a face-worn device, not
// navigation, and high accuracy runs the receiver hotter for precision nobody
// asked for. The wearer wants "roughly where I am."
//
// "Permission denied" and "no fix available" collapse to the same message.
// startAppLocationUpdates resolving false, timing out, and never calling back are
// all indistinguishable from here. The display says "Location unavailable" and
// deliberately NOT "Permission denied", because asserting a cause we cannot
// observe is worse than saying less.
const ACCURACY = AppLocationAccuracy.Low
const TIMEOUT_MS = 10_000
const ACQUIRING_TEXT = 'Acquiring location...'
const UNAVAILABLE_TEXT = 'Location unavailable'

// All of this resets on every open. `active` is the guard every async callback
// checks before acting, so a late resolution after the wearer has left cannot
// touch the page or the subscription.
let active = false
let unsubscribe: (() => void) | null = null
let timeoutId: ReturnType<typeof setTimeout> | null = null

// Whether the GPS page is the one on screen. The shell used to answer this by
// checking its own `screen` state; a tool module should not reach back into the
// shell for it, and the shell only calls these hooks for the active tool anyway.
let isOpen = false

function formatLocation(loc: AppLocation): string {
  return `Lat: ${loc.latitude.toFixed(4)}\nLon: ${loc.longitude.toFixed(4)}`
}

function showLocation(loc: AppLocation) {
  status(`Location: ${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`)
  setContent(formatLocation(loc))
}

function showUnavailable() {
  status('Location unavailable')
  setContent(UNAVAILABLE_TEXT)
}

function start() {
  active = true

  // The timeout shows "unavailable" but deliberately does NOT call stop(). The
  // subscription stays live so a late fix still lands and the page self-heals. A
  // fix at second 14 is better than none. Adding stop() here reads like tidying
  // up missed cleanup, passes every test we have, and silently removes that
  // recovery. Leave the subscription running.
  //
  // The timer starts now, not after startAppLocationUpdates resolves. Worst case
  // is TIMEOUT_MS from page open regardless of how slow the host is to
  // acknowledge, which is bounded rather than "whenever."
  timeoutId = setTimeout(() => {
    timeoutId = null
    if (!active) return
    showUnavailable()
  }, TIMEOUT_MS)

  // Subscribe BEFORE starting updates, so a fast first fix does not arrive before
  // we have a callback to receive it.
  unsubscribe = bridge.onAppLocationChanged(loc => {
    if (!active) return
    if (timeoutId !== null) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
    showLocation(loc)
  })

  bridge.startAppLocationUpdates({ accuracy: ACCURACY }).then(ok => {
    if (!active) return
    if (!ok) {
      // Host refused, or platform error. From here they look identical, so we say
      // the vaguer thing.
      showUnavailable()
      stop()
    }
  })
}

// Stop streaming and clean up. Returns a promise that resolves when the host has
// acknowledged the stop, so callers that want to re-arm immediately can sequence
// correctly. Callers that just want cleanup can ignore it.
function stop(): Promise<void> {
  if (!active) return Promise.resolve()
  active = false

  if (timeoutId !== null) {
    clearTimeout(timeoutId)
    timeoutId = null
  }

  if (unsubscribe !== null) {
    unsubscribe()
    unsubscribe = null
  }

  return bridge.stopAppLocationUpdates().then(ok => {
    if (!ok) status('Failed to stop location updates')
  })
}

// Bring GPS back after a foreground return. The subscription may or may not still
// be live depending on the platform and whether the WebView was suspended;
// tearing down first guarantees a clean re-arm either way. On iOS the
// subscription survives backgrounding, so this is a stop-start that costs a
// fraction of a second. On Android it is likely already dead, so this is the path
// that actually restarts it.
//
// The display is reset to "Acquiring location..." before re-arming. Showing the
// last fix as though it were live is the failure mode this exists to prevent: a
// stale coordinate is indistinguishable from a fresh one at four decimal places.
function rearm() {
  stop().then(() => {
    setContent(ACQUIRING_TEXT).then(() => {
      // Only start if the page is still showing. If the wearer navigated away
      // during the async stop, do not restart a subscription they did not ask for.
      if (isOpen) start()
    })
  })
}

export const gps: Tool = {
  name: 'GPS',
  initialContent: () => ACQUIRING_TEXT,
  onOpen: () => {
    isOpen = true
    start()
  },
  onClose: () => {
    isOpen = false
    stop()
  },
  onResume: rearm,
  onSuspend: stop,
}
