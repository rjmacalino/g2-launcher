import {
  cancelTimer,
  isExpired,
  pauseTimer,
  remainingMs as computeRemainingMs,
  resumeTimer,
  startTimer,
  timerStore,
  type TimerState,
} from './store'
import { status } from '../../platform/bridge'

// The active timer, independent of whether the Timer tool page is open. Same
// shape as weather/service.ts: the status bar shows the countdown on every
// page, so this keeps ticking in the background the same way weather's
// refresh does, and start/stop are driven by the app shell's foreground
// handling rather than the tool's own onOpen/onClose.
let timerState: TimerState = { status: 'idle' }
let tickId: ReturnType<typeof setInterval> | null = null

const listeners = new Set<() => void>()

export function onUpdate(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notify() {
  for (const fn of listeners) fn()
}

function persist() {
  timerStore.write(timerState).then(ok => {
    if (!ok) status('Failed to save timer')
  })
}

// Only ticks while a timer is actually counting down. Paused and idle have
// nothing that changes on their own, so there is no reason to wake up once a
// second for either of them.
function startTicking() {
  if (tickId !== null) return
  tickId = setInterval(tick, 1000)
}

function stopTicking() {
  if (tickId === null) return
  clearInterval(tickId)
  tickId = null
}

// Fired once when a running timer reaches zero on its own (never on a
// cancel), with how long ago it actually ended: zero-ish normally, but
// minutes or hours when the app was in the background or closed through the
// end - ticking stops while backgrounded (see onBackground), so the first
// tick after coming back is where it gets noticed. Used for the "Time's up"
// alert on every screen (app/main.ts) - the Timer screen, which used to be
// the only place that said so, is off the launcher now.
const expiredListeners = new Set<(lateMs: number) => void>()

export function onExpired(fn: (lateMs: number) => void): () => void {
  expiredListeners.add(fn)
  return () => expiredListeners.delete(fn)
}

function tick() {
  const now = Date.now()
  if (timerState.status === 'running' && isExpired(timerState, now)) {
    const lateMs = now - timerState.endTimestamp
    timerState = cancelTimer()
    persist()
    stopTicking()
    notify()
    for (const fn of expiredListeners) fn(lateMs)
    return
  }
  notify()
}

export function getTimer(): TimerState {
  return timerState
}

export function remainingMs(now: number): number {
  return computeRemainingMs(timerState, now)
}

export async function hydrate(): Promise<void> {
  timerState = await timerStore.read()
  if (timerState.status === 'running') startTicking()
}

export function start(durationMs: number) {
  timerState = startTimer(durationMs, Date.now())
  persist()
  startTicking()
  notify()
}

export function pause() {
  timerState = pauseTimer(timerState, Date.now())
  persist()
  stopTicking()
  notify()
}

export function resume() {
  timerState = resumeTimer(timerState, Date.now())
  persist()
  startTicking()
  notify()
}

export function cancel() {
  timerState = cancelTimer()
  persist()
  stopTicking()
  notify()
}

// Foreground return/exit, same resource lifecycle as the status bar clock and
// weather's own background refresh: the OS can suspend a running interval out
// from under us, so this is driven by app/main.ts's foreground events rather
// than a second pattern. Correctness does not depend on this - remaining time
// is always derived from endTimestamp - resuming just repaints promptly
// instead of waiting up to a second for the next natural tick.
export function onForeground() {
  if (timerState.status === 'running') startTicking()
  tick()
}

export function onBackground() {
  stopTicking()
}
