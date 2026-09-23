import { getDaily, getState, onUpdate, refresh } from '../weather-service'
import { CONDITION_LABELS } from '../statusbar'
import { requestRebuild } from '../rebuild'
import type { DailyForecast, HourlyForecast } from '../weather-api'
import type { Tool } from './types'

// Two levels of depth, same shape as Notes and Teleprompter: a picker (which
// day), then a detail view (that day's daytime hours). Both are native lists
// - nothing here is continuous reading, so there is no reason for either
// level to be text.
//
// No infinite scroll, per direct question about it. Two independent reasons:
// the native list widget is firmware-owned for scrolling and gives this app
// no "wearer is nearing the end" signal to hang pagination off of, and a
// forecast beyond Open-Meteo's own ~16-day ceiling is not real data to fetch
// more of in the first place (see FORECAST_DAYS in weather-api.ts). The
// whole 16-day range comes back in the one request weather-service.ts
// already makes, so there is nothing left to page in.
const LOADING_ITEM = 'Getting your forecast...'
const UNAVAILABLE_ITEM = 'Weather unavailable. Check location and try again.'
const EMPTY_HOURS_ITEM = 'No hourly data for this day.'

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

type Depth = 'days' | 'hours'
let depth: Depth = 'days'
let selectedIndex = 0

// Whether this tool's page is the one on screen. Same reasoning as the old
// GPS tool's isOpen flag: a background refresh (weather-service's own timer)
// can land at any time, including while some other tool is open, and only
// THIS flag says whether redrawing is this tool's business right now.
let isOpen = false

function dayLabel(index: number, date: string): string {
  if (index === 0) return 'Today'
  if (index === 1) return 'Tomorrow'
  // date is 'YYYY-MM-DD'; parsed as local midnight (not UTC) so the weekday
  // matches the calendar day the API already resolved via timezone=auto.
  return DAY_NAMES[new Date(`${date}T00:00:00`).getDay()]
}

function hourLabel(hour: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12
  return `${h12}${hour < 12 ? 'am' : 'pm'}`
}

function dayRow(day: DailyForecast, index: number): string {
  const hi = Math.round(day.highCelsius)
  const lo = Math.round(day.lowCelsius)
  return `${dayLabel(index, day.date)}: ${hi}/${lo}C ${CONDITION_LABELS[day.condition]}`.slice(0, 64)
}

function hourRow(hour: HourlyForecast): string {
  return `${hourLabel(hour.hour)}  ${Math.round(hour.celsius)}C  ${CONDITION_LABELS[hour.condition]}`.slice(0, 64)
}

export const weatherTool: Tool = {
  name: 'Weather',
  confirmOnExit: () => true,
  // Matches onConfirmedExit's own logic: from the hourly view, Yes steps
  // back to the day picker, so the question is about the day, not the tool.
  confirmPrompt: () => (depth === 'hours' ? 'Leave this day?' : 'Leave Weather?'),
  contentKind: () => 'list',
  listItems: () => {
    if (depth === 'days') {
      const state = getState()
      if (state === 'loading') return [LOADING_ITEM]
      if (state === 'unavailable') return [UNAVAILABLE_ITEM]
      return getDaily().map(dayRow)
    }
    const day = getDaily()[selectedIndex]
    if (!day || day.hourly.length === 0) return [EMPTY_HOURS_ITEM]
    return day.hourly.map(hourRow)
  },
  onListSelect: index => {
    if (depth !== 'days') return
    if (getState() !== 'ready') return
    const day = getDaily()[index]
    // Absent when the picker shows a loading/unavailable placeholder instead
    // of a real day; guarded above, but also correct if the index is simply
    // out of range.
    if (!day) return
    selectedIndex = index
    depth = 'hours'
  },
  // Confirming leave steps back exactly one level, matching what "back"
  // means everywhere else in this app: from the hourly view, that is the day
  // picker; from the picker itself, there is nowhere shallower left, so it
  // means leaving Weather entirely.
  onConfirmedExit: () => {
    if (depth === 'hours') {
      depth = 'days'
      return 'tool'
    }
    return 'menu'
  },
  onOpen: () => {
    isOpen = true
    // Nudge a refresh in case the background timer has not run recently.
    // Unlike the old text-based version, a list has no in-place content
    // upgrade (see page.ts), so the redraw goes through requestRebuild
    // rather than setContent.
    refresh().then(() => {
      if (isOpen) requestRebuild(weatherTool)
    })
  },
  onClose: () => {
    isOpen = false
    depth = 'days'
  },
  initialContent: () => '',
}

// Only rebuilds while this tool is actually the one open (see isOpen above).
// A background refresh happens every 15 minutes regardless of which tool the
// wearer is looking at; rebuilding whatever else is on screen at that moment
// would cost that tool its scroll position for no reason.
onUpdate(() => {
  if (isOpen) requestRebuild(weatherTool)
})
