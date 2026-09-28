import { bridge, status } from '../../platform/bridge'

// One timer, not a collection. Unlike Notes or Teleprompter scripts there is
// nothing to pick between: the launcher only ever has zero or one timer
// running at a time, so the stored shape is a single state object rather than
// an array with an id to look up.
//
// A discriminated union rather than one shape with optional fields, because
// "running" and "paused" mean different things are meaningful to store.
// Running derives its remaining time from the wall clock (endTimestamp -
// Date.now()), so it needs the end timestamp. Paused has no wall-clock
// relationship to derive from - the clock keeps moving while the timer does
// not - so it freezes a remainingMs snapshot instead. Storing endTimestamp
// for a paused timer would make "remaining" silently count down while
// nothing is actually running.
export type TimerState =
  | { status: 'idle' }
  | { status: 'running'; endTimestamp: number }
  | { status: 'paused'; remainingMs: number }

const IDLE: TimerState = { status: 'idle' }

function isTimerState(x: unknown): x is TimerState {
  if (!x || typeof x !== 'object') return false
  const t = x as Record<string, unknown>
  if (t.status === 'idle') return true
  if (t.status === 'running') return typeof t.endTimestamp === 'number'
  if (t.status === 'paused') return typeof t.remainingMs === 'number'
  return false
}

const TIMER_STORAGE_KEY = 'timer.state'

async function readTimer(): Promise<TimerState> {
  try {
    const raw = await bridge.getLocalStorage(TIMER_STORAGE_KEY)
    const parsed = JSON.parse(raw)
    return isTimerState(parsed) ? parsed : IDLE
  } catch {
    return IDLE
  }
}

function writeTimer(state: TimerState): Promise<boolean> {
  return bridge.setLocalStorage(TIMER_STORAGE_KEY, JSON.stringify(state)).then(ok => {
    if (!ok) status('Failed to save timer')
    return ok
  })
}

// Milliseconds left, clamped to zero. Never negative: a running timer read
// after its endTimestamp has already passed (the app was suspended through
// the whole duration, for instance) is "done", not "overdue by -4000ms".
export function remainingMs(state: TimerState, now: number): number {
  if (state.status === 'idle') return 0
  if (state.status === 'paused') return Math.max(0, state.remainingMs)
  return Math.max(0, state.endTimestamp - now)
}

export function isExpired(state: TimerState, now: number): boolean {
  return state.status === 'running' && state.endTimestamp <= now
}

export function startTimer(durationMs: number, now: number): TimerState {
  return { status: 'running', endTimestamp: now + durationMs }
}

// No-op (returns state unchanged) when called on anything but a running
// timer. Pausing an idle timer, or one already paused, has nothing to do.
export function pauseTimer(state: TimerState, now: number): TimerState {
  if (state.status !== 'running') return state
  return { status: 'paused', remainingMs: remainingMs(state, now) }
}

// Re-enters 'running' from a fresh endTimestamp computed against the current
// clock, not the one that was ticking when it was paused - the whole reason
// pause has to store a snapshot instead of an endTimestamp in the first
// place.
export function resumeTimer(state: TimerState, now: number): TimerState {
  if (state.status !== 'paused') return state
  return { status: 'running', endTimestamp: now + state.remainingMs }
}

export function cancelTimer(): TimerState {
  return IDLE
}

export const timerStore = {
  read: readTimer,
  write: writeTimer,
}
