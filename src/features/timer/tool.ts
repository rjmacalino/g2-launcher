import { cancel, getTimer, hydrate, onUpdate, pause, remainingMs, resume, start } from './service'
import { setContent } from '../../platform/page'
import { status } from '../../platform/bridge'
import { formatDuration } from '../../shared/duration'
import { requestRebuild } from '../../core/rebuild'
import type { Tool } from '../../core/tool'

// Two pickers, then a running/paused display, then back to the pickers.
// Unlike Notes' or Teleprompter's picker/reading split, leaving this tool
// never has anything to lose: a running timer is persisted and keeps
// counting down independently of whether this screen is open (see
// features/timer/service.ts - the same background-ticking shape as weather's
// own service, which is what lets the status bar show it with this tool
// closed entirely), so there is no confirmOnExit here at all.
type PickerStage = 'hour' | 'minute'
let pickerStage: PickerStage = 'hour'
let selectedHours = 0

// Whether THIS tool's page is the one on screen, same reasoning as Weather's
// own isOpen: the service's background tick can land at any time, including
// while some other tool is open, and only this flag says whether reacting to
// it is this tool's business right now.
let isOpen = false

// True from the moment a running timer's remaining time hits zero while this
// screen is open, until the wearer double-taps past it. Purely a display
// concern - the service itself has already gone back to idle by the time
// this is noticed - so it lives here, not in TimerState. Opening the tool
// fresh after an expiry that happened off-screen skips straight to idle's
// picker instead of a stale "time's up", the same "only while the app is
// open" scope alarms already have (see docs/roadmap.md decision D2).
let expired = false

// Tracks whether the timer was active last time the onUpdate handler below
// ran, so it can tell "it just expired on its own" (was active, now is not)
// apart from a deliberate cancel, which resets this itself first.
let wasActive = false

// What is ACTUALLY on screen right now, as opposed to "what should it be for
// the current state." The two disagree for one instant after onListSelect
// calls start(): getTimer().status flips to 'running' immediately, but the
// container on screen is still the list built for the picker until the
// shell's rebuild lands a moment later. Reacting to the service's own
// synchronous notify() during that instant would send a text upgrade
// (setContent) at what is still a list container. suppressNextNotify skips
// exactly that one notification, since the shell's own rebuild (triggered by
// onListSelect returning, not by this tool) already repaints correctly via
// initialContent().
let suppressNextNotify = false

// Same "what is actually on screen" idea, kept in sync explicitly rather than
// derived from contentKind() for the same reason: contentKind() answers what
// SHOULD be on screen for the current state, which can be ahead of what
// actually is.
let renderedKind: 'list' | 'text' = 'list'

const HOURS_MAX = 9
const MINUTE_STEP = 5

function hourLabel(h: number): string {
  return `${h} ${h === 1 ? 'hour' : 'hours'}`
}

function minuteLabel(m: number): string {
  return `${m} min`
}

function runningContent(): string {
  if (expired) return "Time's up!\n\nDouble-tap to continue"
  const state = getTimer()
  const remaining = formatDuration(remainingMs(Date.now()))
  if (state.status === 'paused') return `${remaining}\nPaused\n\nTap+hold for menu`
  return `${remaining}\n\nTap+hold for menu`
}

async function refresh(): Promise<void> {
  expired = false
  wasActive = getTimer().status !== 'idle'
  renderedKind = wasActive ? 'text' : 'list'
  pickerStage = 'hour'
  selectedHours = 0
}

export const timerTool: Tool = {
  name: 'Timer',
  // Loads the persisted TimerState once at startup, same Promise.all the
  // shell already awaits for every tool's own hydrate before deciding what
  // screen to restore into - Timer needs this done first for the same reason
  // Notes and Teleprompter do: contentKind/initialContent read it
  // synchronously and have no other chance to wait for it.
  hydrate,
  beforeOpen: refresh,
  contentKind: () => (getTimer().status === 'idle' && !expired ? 'list' : 'text'),
  listItems: () =>
    pickerStage === 'hour'
      ? Array.from({ length: HOURS_MAX + 1 }, (_, h) => hourLabel(h))
      : Array.from({ length: 60 / MINUTE_STEP }, (_, i) => minuteLabel(i * MINUTE_STEP)),
  onListSelect: index => {
    if (pickerStage === 'hour') {
      selectedHours = index
      pickerStage = 'minute'
      return
    }
    const minutes = index * MINUTE_STEP
    const durationMs = (selectedHours * 60 + minutes) * 60_000
    if (durationMs <= 0) {
      status('Timer: pick at least 5 minutes')
      return
    }
    suppressNextNotify = true
    start(durationMs)
    wasActive = true
    pickerStage = 'hour'
  },
  // Fires after the shell's rebuild from onListSelect (picker -> running)
  // lands, which is the moment the on-screen container actually becomes text.
  onContentReady: () => {
    renderedKind = 'text'
  },
  onOpen: () => {
    isOpen = true
  },
  onClose: () => {
    isOpen = false
  },
  contextMenu: () => {
    if (getTimer().status === 'idle') return []
    return [
      { itemName: getTimer().status === 'paused' ? 'Resume' : 'Pause', itemID: 1 },
      { itemName: 'Cancel', itemID: 2 },
    ]
  },
  onMenuItemClick: itemID => {
    if (getTimer().status === 'idle') return
    if (itemID === 1) {
      if (getTimer().status === 'paused') resume()
      else pause()
      return
    }
    if (itemID === 2) {
      // Cleared before cancel(), not after: cancel()'s own notify() fires
      // synchronously, and the onUpdate handler below must see wasActive
      // already false to know this is a deliberate stop, not an expiry.
      wasActive = false
      expired = false
      cancel()
      status('Timer cancelled')
    }
  },
  // Read whenever a page is built or rebuilt with contentKind 'text' -
  // including the very first paint of the picker -> running transition,
  // before any tick has had a chance to call setContent. Blank whenever
  // contentKind is actually 'list' instead; never rendered there.
  initialContent: () => (getTimer().status !== 'idle' || expired ? runningContent() : ''),
}

// The service's own background tick (see features/timer/service.ts) is what
// actually counts down; this only repaints the currently-open page when it
// does, same split as Weather's tool.ts and its onUpdate. Three outcomes per
// notification: the timer just expired on its own (switch to "Time's up!"),
// the picker/running split changed some other way, i.e. a menu cancel
// (rebuild - a list and a text container are not interchangeable via
// setContent), or neither (repaint the countdown in place).
onUpdate(() => {
  if (suppressNextNotify) {
    suppressNextNotify = false
    return
  }
  if (!isOpen) return
  const active = getTimer().status !== 'idle'
  if (wasActive && !active) expired = true
  wasActive = active
  const desiredKind: 'list' | 'text' = getTimer().status === 'idle' && !expired ? 'list' : 'text'
  if (desiredKind !== renderedKind) {
    renderedKind = desiredKind
    requestRebuild(timerTool)
    return
  }
  if (renderedKind === 'text') setContent(runningContent())
})
