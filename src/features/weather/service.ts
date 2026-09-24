import { fetchForecast, type DailyForecast } from './api'
import type { CurrentWeather } from './conditions'
import { getCurrentLocation } from '../../platform/location'
import { status } from '../../platform/bridge'

// Weather data lives here, independent of whether the Weather tool page is
// open. The status bar shows current conditions on every page, so this keeps
// refreshing in the background the same way the clock does: start()/stop()
// are called from the app shell's foreground handling, not from the tool's
// own onOpen/onClose.
//
// This module knows nothing about the status bar or any page. Subscribers
// (the shell for the status bar, the Weather tool for its own page) listen
// via onUpdate and read getCurrent()/getDaily()/getState() themselves.
const REFRESH_INTERVAL_MS = 15 * 60 * 1000

export type WeatherState = 'loading' | 'ready' | 'unavailable'

let state: WeatherState = 'loading'
let daily: DailyForecast[] = []
let current: CurrentWeather | null = null
let timerId: ReturnType<typeof setInterval> | null = null

// Coalesced: a resume and the periodic timer landing at the same moment
// should not fire two overlapping fetches racing each other's result into
// `daily`. Every caller awaits the same in-flight promise instead of each
// starting its own.
let inFlight: Promise<void> | null = null

// Tools with a stake in fresh data subscribe here instead of polling. Kept
// deliberately dumb (a Set of callbacks, no payload) - a subscriber reads
// getState()/getDaily() itself when notified, same as everything else in
// this app treats "the data changed" as a cue to re-read, not a channel to
// carry the data itself.
const listeners = new Set<() => void>()

export function onUpdate(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notify() {
  for (const fn of listeners) fn()
}

export function refresh(): Promise<void> {
  if (inFlight) return inFlight

  inFlight = (async () => {
    const loc = await getCurrentLocation()
    if (!loc) {
      state = 'unavailable'
      // Cleared rather than left holding a stale reading from the last
      // successful fetch: once a refresh confirms we have no real data,
      // showing an old number silently is worse than showing "no data".
      current = null
      // Distinguishes "never got a location fix" from a forecast fetch
      // failing below - both used to collapse into the same silent
      // "unavailable", which made this undiagnosable from the status strip
      // alone. A denied/unavailable permission and a request that simply
      // timed out still look the same from here (see platform/location.ts), but at
      // least which STAGE failed is now visible.
      status('Weather: no location fix (permission denied, or no fix in time)')
      return
    }

    try {
      const result = await fetchForecast(loc.latitude, loc.longitude)
      daily = result.daily
      state = 'ready'
      current = result.current
    } catch (e) {
      state = 'unavailable'
      current = null
      status(`Weather update failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  })().finally(() => {
    inFlight = null
    notify()
  })

  return inFlight
}

export function getState(): WeatherState {
  return state
}

export function getDaily(): DailyForecast[] {
  return daily
}

export function getCurrent(): CurrentWeather | null {
  return current
}

// Resource lifecycle in the same shape as the status bar clock and, before
// it, the GPS subscription: runs until stopped, invisible if leaked, and the
// OS suspends the app out from under it, so start/stop are driven by the
// same foreground enter/exit events in app/main.ts rather than a second pattern.
export function start() {
  if (timerId !== null) return
  refresh()
  timerId = setInterval(refresh, REFRESH_INTERVAL_MS)
}

export function stop() {
  if (timerId === null) return
  clearInterval(timerId)
  timerId = null
}
