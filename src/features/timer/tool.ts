import {
  cancelTimer,
  isExpired,
  pauseTimer,
  remainingMs,
  resumeTimer,
  startTimer,
  timerStore,
  type TimerState,
} from './store'
import { setContent } from '../../platform/page'
import { status } from '../../platform/bridge'
import type { Tool } from '../../core/tool'

// Two pickers, then a running/paused display, then back to the pickers.
// Nothing here is nameable as Notes' or Teleprompter's picker/reading split -
// unlike those, "leaving" this tool never has anything to lose: a running
// timer is persisted independently of whether this screen is open (see
// setWeather/status bar for the same idea - the countdown keeps going and
// shows on the status bar with this tool closed entirely), so there is no
// confirmOnExit here at all.
type PickerStage = 'hour' | 'minute'
let pickerStage: PickerStage = 'hour'
let selectedHours = 0

// True right after a running timer's remaining time hits zero, until the
// wearer double-taps past it. Not part of TimerState: expiry is purely a
// display concern here, the store itself just goes back to idle the moment
// it happens (see tick() below), same as an alarm clock's own state has
// nothing left to say once it has rung.
let expired = false

let timerState: TimerState = { status: 'idle' }
let tickId: ReturnType<typeof setInterval> | null = null

const HOURS_MAX = 9
const MINUTE_STEP = 5

function hourLabel(h: number): string {
  return `${h} ${h === 1 ? 'hour' : 'hours'}`
}

function minuteLabel(m: number): string {
  return `${m} min`
}

// h:mm:ss once there is an hour to show, m:ss otherwise - a plain stopwatch
// read, not zero-padded to a fixed width the way the status bar's clock is,
// since this is the one number filling the whole content area on its own.
function formatRemaining(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

function runningContent(): string {
  if (expired) return "Time's up!\n\nDouble-tap to continue"
  const remaining = formatRemaining(remainingMs(timerState, Date.now()))
  if (timerState.status === 'paused') {
    return `${remaining}\nPaused\n\nTap+hold for menu`
  }
  return `${remaining}\n\nTap+hold for menu`
}

// Repaints the on-screen countdown once a second. This is a display refresh
// only - it does not decide whether the timer has expired on its own; that
// check happens once here per tick and writes the result back to the store,
// same single-writer shape as everywhere else in this app that owns a
// setInterval (see app/statusbar.ts's own refresh()).
function tick() {
  if (timerState.status === 'running' && isExpired(timerState, Date.now())) {
    timerState = cancelTimer()
    timerStore.write(timerState)
    expired = true
    stopTicking()
  }
  setContent(runningContent())
}

function startTicking() {
  if (tickId !== null) return
  tick()
  tickId = setInterval(tick, 1000)
}

function stopTicking() {
  if (tickId === null) return
  clearInterval(tickId)
  tickId = null
}

async function refresh(): Promise<void> {
  timerState = await timerStore.read()
  expired = false
  pickerStage = 'hour'
  selectedHours = 0
}

export const timerTool: Tool = {
  name: 'Timer',
  beforeOpen: refresh,
  contentKind: () => (timerState.status === 'idle' && !expired ? 'list' : 'text'),
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
    timerState = startTimer(durationMs, Date.now())
    timerStore.write(timerState)
    pickerStage = 'hour'
  },
  // Only fires on a rebuild THIS tool triggered (the hour->minute step stays
  // 'list' the whole time, so the only internal transition that lands here is
  // minute picked -> running). onOpen covers the other way into 'running': the
  // tool opened straight into an already-active timer from a previous open.
  onContentReady: () => {
    if (timerState.status !== 'idle') startTicking()
  },
  onOpen: () => {
    if (timerState.status !== 'idle') startTicking()
  },
  onClose: stopTicking,
  onResume: () => {
    if (timerState.status !== 'idle') startTicking()
  },
  onSuspend: stopTicking,
  contextMenu: () => {
    if (timerState.status === 'idle') return []
    return [
      { itemName: timerState.status === 'paused' ? 'Resume' : 'Pause', itemID: 1 },
      { itemName: 'Cancel', itemID: 2 },
    ]
  },
  onMenuItemClick: itemID => {
    if (timerState.status === 'idle') return
    if (itemID === 1) {
      timerState =
        timerState.status === 'paused'
          ? resumeTimer(timerState, Date.now())
          : pauseTimer(timerState, Date.now())
      timerStore.write(timerState)
      setContent(runningContent())
      return
    }
    if (itemID === 2) {
      timerState = cancelTimer()
      timerStore.write(timerState)
      expired = false
      stopTicking()
      status('Timer cancelled')
    }
  },
  // Never actually rendered: contentKind is 'list' whenever this would be
  // used. Required by the interface regardless, same as Notes.
  initialContent: () => '',
}
