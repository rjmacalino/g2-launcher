import { TextContainerProperty, TextContainerUpgrade } from '@evenrealities/even_hub_sdk'
import { bridge, status } from './bridge'
import {
  CANVAS_WIDTH,
  CONTAINER_ID_STATUS,
  CONTAINER_NAME_STATUS,
  PADDING,
  STATUS_BAR_HEIGHT,
} from './page'
import { STORAGE_KEY_STATUS_BAR, readJson, readWithTimeout } from './storage'

// Information that stays on screen regardless of which tool is open. A bar that
// only appears on some pages is worse than no bar, because glancing at it stops
// being reliable, so every page carries it and there is no way to build a page
// that does not.
//
// Which fields appear is the wearer's choice. The config is persisted now even
// though the UI to edit it comes later on the companion page, because the shape
// of the stored value is what the settings screen will edit and getting it wrong
// later means a migration.
export type StatusBarConfig = {
  time: boolean
  date: boolean
  temperature: boolean
}

// Temperature defaults off because there is nothing to show yet. Turning it on
// before a proxy exists would mean a field that is always blank.
const DEFAULTS: StatusBarConfig = {
  time: true,
  date: true,
  temperature: false,
}

// The clock shows minutes, so a one-second timer would be 59 wasted host round
// trips a minute. Polling faster than the displayed resolution and skipping the
// update when the rendered string has not changed keeps the clock never more than
// this far behind, at roughly one actual upgrade per minute.
const TICK_MS = 15_000

let config: StatusBarConfig = { ...DEFAULTS }

// Filled in once a weather proxy exists. Until then the temperature field has a
// defined place in the model and renders nothing.
const temperatureText: string | null = null

let timerId: ReturnType<typeof setInterval> | null = null

// What the bar currently shows. Kept in sync by every path that draws it, so the
// tick can skip an upgrade when nothing has changed.
let lastText = ''

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

// Formatted by hand rather than through toLocaleString. Locale output varies by
// host and can contain non-ASCII, and this repo is deliberately ASCII only.
function formatClock(now: Date): string {
  const h = String(now.getHours()).padStart(2, '0')
  const m = String(now.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

function formatDate(now: Date): string {
  return `${DAY_NAMES[now.getDay()]} ${now.getDate()} ${MONTH_NAMES[now.getMonth()]}`
}

function render(): string {
  const now = new Date()
  const parts: string[] = []
  if (config.time) parts.push(formatClock(now))
  if (config.date) parts.push(formatDate(now))
  if (config.temperature && temperatureText) parts.push(temperatureText)
  return parts.join('   ')
}

// Read the persisted config. Any failure falls back to defaults rather than an
// empty bar: a wearer who has never opened settings should still get a clock, and
// a corrupt value should not produce a blank strip they cannot explain.
async function readConfig(): Promise<StatusBarConfig> {
  const parsed = await readJson(STORAGE_KEY_STATUS_BAR)
  if (!parsed) return { ...DEFAULTS }
  return {
    time: typeof parsed.time === 'boolean' ? parsed.time : DEFAULTS.time,
    date: typeof parsed.date === 'boolean' ? parsed.date : DEFAULTS.date,
    temperature:
      typeof parsed.temperature === 'boolean' ? parsed.temperature : DEFAULTS.temperature,
  }
}

// Load the stored config. The bar is drawn during page creation, before this
// resolves, so the first frame uses defaults and is corrected afterwards.
// Awaiting it before page creation would block the first frame on storage, which
// is what the startup order exists to avoid. refresh() skips even the correcting
// upgrade when the stored config matches the defaults.
export async function hydrate(): Promise<void> {
  config = await readWithTimeout(readConfig(), { ...DEFAULTS })
}

// The bar container. Every page builder calls this, which is what makes the bar
// impossible to omit. It records what it drew so the tick can dedupe against it.
export function statusBarContainer(): TextContainerProperty {
  lastText = render()
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: CANVAS_WIDTH,
    height: STATUS_BAR_HEIGHT,
    borderWidth: 0,
    paddingLength: PADDING,
    containerID: CONTAINER_ID_STATUS,
    containerName: CONTAINER_NAME_STATUS,
    content: lastText,
    // Never the capture container. Exactly one container per page receives input
    // and it is always the content, because the bar is not interactive and taking
    // capture would strand the wearer on every page at once.
    //
    // It also matters for a reason discovered later: the firmware only scrolls a
    // container that has capture. Giving the bar capture would hand it scrolling
    // as well as input.
    isEventCapture: 0,
  })
}

function refresh() {
  const text = render()
  if (text === lastText) return
  lastText = text
  bridge
    .textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: CONTAINER_ID_STATUS,
        containerName: CONTAINER_NAME_STATUS,
        content: text,
      }),
    )
    .then(ok => {
      if (!ok) status('Status bar update failed')
    })
}

// The timer is a resource in the same sense the GPS subscription is: it runs
// until stopped, a leaked one is invisible, and the OS suspends it out from under
// us. Same lifecycle handling as GPS rather than a second pattern beside it.
export function startStatusBar() {
  if (timerId !== null) return
  // Refresh immediately. After a resume the displayed time is as stale as the
  // suspension was long, and waiting a tick to correct it is the one moment a
  // wearer is most likely to be looking at the clock.
  refresh()
  timerId = setInterval(refresh, TICK_MS)
}

export function stopStatusBar() {
  if (timerId === null) return
  clearInterval(timerId)
  timerId = null
}
