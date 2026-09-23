import { AppLocationAccuracy, type AppLocation } from '@evenrealities/even_hub_sdk'
import { bridge } from './bridge'

// A one-shot location fix, not a live-tracking page. This is what is left of
// the old dedicated GPS tool after it was removed per direct request -
// nobody used a standalone lat/lon readout, but Weather still needs to know
// roughly where the wearer is, so the platform plumbing (permission,
// subscribe-before-start, the ack/receive distinction) moved here instead of
// being duplicated.
//
// Accuracy is Low for the same reason the old GPS tool used it: this is a
// launcher on a face-worn device, not navigation, and a weather forecast does
// not need better than "roughly where I am."
const ACCURACY = AppLocationAccuracy.Low
const TIMEOUT_MS = 10_000

// Resolves with the first fix, or null if none arrives within TIMEOUT_MS, the
// host refuses, or the subscription errors. Every path stops the subscription
// before resolving: unlike the old GPS tool, nothing here stays open waiting
// for a late fix, because there is no page for a late fix to update.
export function getCurrentLocation(): Promise<AppLocation | null> {
  return new Promise(resolve => {
    let settled = false
    let unsubscribe: (() => void) | null = null
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    function finish(loc: AppLocation | null) {
      if (settled) return
      settled = true
      if (timeoutId !== null) clearTimeout(timeoutId)
      if (unsubscribe !== null) unsubscribe()
      bridge.stopAppLocationUpdates()
      resolve(loc)
    }

    timeoutId = setTimeout(() => finish(null), TIMEOUT_MS)

    // Subscribe BEFORE starting updates, same reasoning as the old GPS tool:
    // a fast first fix should never arrive before there is a callback to
    // receive it.
    unsubscribe = bridge.onAppLocationChanged(loc => finish(loc))

    bridge.startAppLocationUpdates({ accuracy: ACCURACY }).then(ok => {
      if (!ok) finish(null)
    })
  })
}
