import { TextContainerProperty, TextContainerUpgrade } from '@evenrealities/even_hub_sdk'
import { bridge, status } from '../platform/bridge'
import {
  CONTAINER_ID_STATUS_CENTRE,
  CONTAINER_ID_STATUS_LEFT,
  CONTAINER_ID_STATUS_RIGHT,
  PADDING,
  STATUS_BAR_HEIGHT,
} from '../platform/page'
import { STORAGE_KEY_STATUS_BAR, readJson, readWithTimeout } from '../platform/storage'
import { currentConditionWord, type CurrentWeather } from '../features/weather/conditions'
import { getTextWidth } from '../platform/text'

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

// Temperature now defaults on. It used to default off because there was
// nothing to show yet - true while Weather was a placeholder, no longer true
// now that it fetches real conditions (see features/weather/service.ts). Leaving this
// off by default would have meant the centre slot stayed silently blank on
// every device forever, since nothing else ever flips it on.
const DEFAULTS: StatusBarConfig = {
  time: true,
  date: true,
  temperature: true,
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
//
// 12 hour with an AM/PM suffix and no zero padding on the hour, so 9:05AM rather
// than 09:05AM. Note that midnight and noon are the cases a naive `h % 12` gets
// wrong, landing on 0 instead of 12.
function formatClock(now: Date): string {
  const h24 = now.getHours()
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  const m = String(now.getMinutes()).padStart(2, '0')
  return `${h12}:${m} ${h24 < 12 ? 'AM' : 'PM'}`
}

function formatDate(now: Date): string {
  return `${DAY_NAMES[now.getDay()]} ${now.getDate()} ${MONTH_NAMES[now.getMonth()]}`
}

// What the weather slot shows. The app shell pushes the current reading here
// whenever the weather service refreshes (see app/main.ts).
//
// Shown whenever there is no current reading: before the very first refresh
// completes at startup, and after a failed refresh (no location fix, or the
// forecast request itself failing). A blank slot looked like the field was
// simply off; naming the gap is more honest, per direct request.
const NO_DATA_TEXT = 'N/A'

let weather: CurrentWeather | null = null

function renderWeather(): string {
  if (!weather) return NO_DATA_TEXT
  return `${currentConditionWord(weather)} ${Math.round(weather.celsius)}C`
}

// Date on the left, weather in the middle, time on the right.
//
// Widths were a screenshot-measured guess ("Wed 23 Sep" at roughly 105px, so
// ~10.5px per character); @evenrealities/pretext now gives the real number
// for whichever string actually renders, computed below rather than assumed.
// The 180/180/116 slot widths keep the same generous margin over the
// measured worst case they always had - not tightened here, since the
// current 3-slot spacing was already tuned against real hardware (see the
// status bar tick marks investigation below) and narrowing it needs its own
// hardware check, not a drive-by change alongside a measurement library swap.
const WIDEST_DATE_PX = Math.max(...DAY_NAMES.map((_, i) => getTextWidth(`${DAY_NAMES[i]} 30 Sep`)))
const WIDEST_TIME_PX = getTextWidth('12:30 PM')

const SLOTS: readonly Slot[] = [
  {
    id: CONTAINER_ID_STATUS_LEFT,
    name: 'status.left',
    x: 0,
    width: 180,
    field: 'date',
    render: formatDate,
  },
  {
    id: CONTAINER_ID_STATUS_CENTRE,
    name: 'status.centre',
    x: 210,
    width: 180,
    field: 'temperature',
    render: renderWeather,
  },
  {
    id: CONTAINER_ID_STATUS_RIGHT,
    name: 'status.right',
    // Positioned so a typical time ends near the right edge. Text is left-aligned
    // inside the container, so this is right-ish rather than truly right-aligned,
    // which is the closest the platform allows.
    x: 460,
    width: 116,
    field: 'time',
    render: formatClock,
  },
]

// Catches a slot becoming too narrow for its own worst-case content - a
// silent clip, not a crash, so nothing else would surface it. Runs once at
// module load, not on a hot path.
const dateSlot = SLOTS.find(s => s.field === 'date')
const timeSlot = SLOTS.find(s => s.field === 'time')
if (dateSlot && WIDEST_DATE_PX > dateSlot.width - 2 * PADDING) {
  status(`Status bar date slot may be too narrow: ${WIDEST_DATE_PX}px content in ${dateSlot.width}px`)
}
if (timeSlot && WIDEST_TIME_PX > timeSlot.width - 2 * PADDING) {
  status(`Status bar time slot may be too narrow: ${WIDEST_TIME_PX}px content in ${timeSlot.width}px`)
}

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

// RESOLVED. Two thin vertical tick marks near the status bar edges turned out
// to be a real, fixable thing: placing sibling text containers edge to edge
// on the same row draws a boundary mark, confirmed by collapsing the three
// slots into one and watching two of three ticks disappear. A third tick, at
// the far right where any status bar layout touches the canvas edge, survived
// even when nothing we drew reached that corner (tested by insetting content
// 26px from the edge and checking real hardware) - confirmed OS-owned chrome,
// not something we draw, not something to keep chasing.
//
// Net decision: keep the three-slot layout. It positions date, weather and
// time apart from each other, which is the actual reason this file exists
// (see the comment on SLOTS below); collapsing to one container removes the
// two fixable ticks but reintroduces the left-clustered text problem the
// three-slot design was built to solve in the first place, which is the
// worse trade. The remaining corner tick is unaffected either way, so there
// is nothing left to gain by giving up the readable layout for it.

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

// Set the weather shown in the centre slot. Called by the app shell after every
// weather refresh, success or failure (null clears the slot to the N/A
// placeholder - see NO_DATA_TEXT).
//
// Takes Celsius as a number rather than a preformatted string, so the display
// format stays a decision this file owns and the weather tool cannot drift from it.
export function setWeather(next: CurrentWeather | null) {
  weather = next
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
