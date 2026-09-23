import { fetchForecast, type DailyForecast } from './weather-api'
import { getCurrentLocation } from './location'
import { CONDITION_LABELS, setWeather } from './statusbar'
import { status } from './bridge'

// Weather data lives here, independent of whether the Weather tool page is
// open. The status bar shows current conditions on every page (see
// setWeather in statusbar.ts), so this has to keep refreshing in the
// background the same way the clock does - start()/stop() are called
// alongside startStatusBar()/stopStatusBar() in main.ts, not from the tool's
// own onOpen/onClose. The Weather tool (tools/weather.ts) just reads
// whatever this module already has.
const REFRESH_INTERVAL_MS = 15 * 60 * 1000

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export const LOADING_TEXT = 'Getting your forecast...'
export const UNAVAILABLE_TEXT = 'Weather unavailable.\nCheck location and try again.'

let forecastText = LOADING_TEXT
let timerId: ReturnType<typeof setInterval> | null = null

// Coalesced: a resume and the periodic timer landing at the same moment
// should not fire two overlapping fetches racing each other's result into
// forecastText. Every caller awaits the same in-flight promise instead of
// each starting its own.
let inFlight: Promise<void> | null = null

function dayLabel(index: number): string {
  if (index === 0) return 'Today'
  if (index === 1) return 'Tomorrow'
  // Anchored to the device's own clock, not the forecast location's - a
  // wearer travelling across timezones gets a weekday name that can be off
  // by one near midnight, which is an acceptable approximation for a day
  // label, same spirit as the other measured-not-exact constants in page.ts.
  return DAY_NAMES[new Date(Date.now() + index * 86_400_000).getDay()]
}

function formatForecast(days: DailyForecast[]): string {
  return days
    .map(
      (day, i) =>
        `${dayLabel(i)}: ${Math.round(day.highCelsius)}/${Math.round(day.lowCelsius)}C ${CONDITION_LABELS[day.condition]}`,
    )
    .join('\n')
}

export function refresh(): Promise<void> {
  if (inFlight) return inFlight

  inFlight = (async () => {
    const loc = await getCurrentLocation()
    if (!loc) {
      forecastText = UNAVAILABLE_TEXT
      return
    }

    try {
      const result = await fetchForecast(loc.latitude, loc.longitude)
      forecastText = formatForecast(result.daily)
      setWeather(result.current)
    } catch {
      forecastText = UNAVAILABLE_TEXT
      status('Weather update failed')
    }
  })().finally(() => {
    inFlight = null
  })

  return inFlight
}

export function getForecastText(): string {
  return forecastText
}

// Resource lifecycle in the same shape as the status bar clock and, before
// it, the GPS subscription: runs until stopped, invisible if leaked, and the
// OS suspends the app out from under it, so start/stop are driven by the
// same foreground enter/exit events in main.ts rather than a second pattern.
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
