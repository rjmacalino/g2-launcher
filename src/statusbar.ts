import { TextContainerProperty, TextContainerUpgrade } from '@evenrealities/even_hub_sdk'
import { bridge, status } from './bridge'
import {
  CONTAINER_ID_STATUS_CENTRE,
  CONTAINER_ID_STATUS_LEFT,
  CONTAINER_ID_STATUS_RIGHT,
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
// though the UI to edit it comes later on the companion page, because the shape of
// the stored value is what the settings screen will edit and getting it wrong
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
// update when a slot's text has not changed keeps the clock never more than this
// far behind, at roughly one actual upgrade per minute.
const TICK_MS = 15_000

// One container per field, positioned across the bar.
//
// Text containers are left-aligned with no alignment option, so a single
// full-width container leaves everything huddled in the left third. Alignment is
// unavailable but placement is not: three containers at chosen x positions give
// what alignment would have given.
//
// Each slot keeps its position whether or not its field is on. A slot that is off
// renders empty rather than collapsing, so toggling one field never moves the
// other two. A bar whose contents shift around defeats the point of having one,
// which is being readable at a glance without actually reading it.
type Slot = {
  readonly id: number
  readonly name: string
  readonly x: number
  readonly width: number
  readonly field: keyof StatusBarConfig
  render(now: Date): string
}

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

// Filled in once a weather proxy exists. Until then the temperature slot has a
// defined place on screen and renders nothing.
let temperatureText: string | null = null

const SLOTS: readonly Slot[] = [
  {
    id: CONTAINER_ID_STATUS_LEFT,
    name: 'status.left',
    x: 0,
    width: 150,
    field: 'time',
    render: formatClock,
  },
  {
    id: CONTAINER_ID_STATUS_CENTRE,
    name: 'status.centre',
    x: 210,
    width: 150,
    field: 'temperature',
    render: () => temperatureText ?? '',
  },
  {
    id: CONTAINER_ID_STATUS_RIGHT,
    name: 'status.right',
    // Positioned so a typical date ends near the right edge. Text is
    // left-aligned inside the container, so this is right-ish rather than truly
    // right-aligned, which is the closest the platform allows.
    x: 420,
    width: 156,
    field: 'date',
    render: formatDate,
  },
]

let config: StatusBarConfig = { ...DEFAULTS }

let timerId: ReturnType<typeof setInterval> | null = null

// What each slot currently shows, so a tick can skip the slots that have not
// changed. Keyed by container ID. On a normal minute rollover only the clock
// moves, so this is one host round trip rather than three.
const lastText = new Map<number, string>()

function renderSlot(slot: Slot, now: Date): string {
  if (!config[slot.field]) return ''
  return slot.render(now)
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
// resolves, so the first frame uses defaults and is corrected afterwards. Awaiting
// it before page creation would block the first frame on storage, which is what
// the startup order exists to avoid. refresh() skips even the correcting upgrade
// for any slot whose text is unchanged.
export async function hydrate(): Promise<void> {
  config = await readWithTimeout(readConfig(), { ...DEFAULTS })
}

// The bar's containers. Every page builder spreads these in, which is what makes a
// page without a bar impossible to construct. They record what they drew so the
// tick can dedupe against it.
export function statusBarContainers(): TextContainerProperty[] {
  const now = new Date()
  return SLOTS.map(slot => {
    const text = renderSlot(slot, now)
    lastText.set(slot.id, text)
    return new TextContainerProperty({
      xPosition: slot.x,
      yPosition: 0,
      width: slot.width,
      height: STATUS_BAR_HEIGHT,
      borderWidth: 0,
      paddingLength: PADDING,
      containerID: slot.id,
      containerName: slot.name,
      content: text,
      // Never the capture container. Exactly one container per page receives
      // input and it is always the content, because the bar is not interactive
      // and taking capture would strand the wearer on every page at once.
      //
      // It also matters for a reason discovered later: the firmware only scrolls
      // a container that has capture. Giving a bar slot capture would hand it
      // scrolling as well as input.
      isEventCapture: 0,
    })
  })
}

function refresh() {
  const now = new Date()
  for (const slot of SLOTS) {
    const text = renderSlot(slot, now)
    if (lastText.get(slot.id) === text) continue
    lastText.set(slot.id, text)
    bridge
      .textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: slot.id,
          containerName: slot.name,
          content: text,
        }),
      )
      .then(ok => {
        if (!ok) status(`Status bar slot ${slot.name} update failed`)
      })
  }
}

// Set the temperature shown in the centre slot. Nothing calls this yet; weather
// needs a proxy, because an API key cannot ship inside an extractable package.
// Exported so the slot has a defined way in rather than a placeholder nobody can
// find later.
export function setTemperature(text: string | null) {
  temperatureText = text
  refresh()
}

// The timer is a resource in the same sense the GPS subscription is: it runs until
// stopped, a leaked one is invisible, and the OS suspends it out from under us.
// Same lifecycle handling as GPS rather than a second pattern beside it.
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
