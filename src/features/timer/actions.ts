import type { AssistantAction } from '../../core/assistantActions'
import { describeDuration } from '../../shared/duration'
import { cancel, getTimer, pause, remainingMs, resume, start } from './service'

// What Jarvis can do to the timer, by voice. Each returns the sentence the
// wearer sees. Shared by both ways a spoken timer request gets here: the
// on-phone fast path in app/main.ts (features/timer/voiceCommand.ts, no
// network and no API key needed) and Gemini function calling for anything
// that parser does not recognise ("set a timer for five minutes" in words,
// "give me a quarter of an hour"). One set of messages, whichever path ran.

// A day. Far past any real kitchen or workout timer, and catches a misheard
// or mis-parsed number before it becomes a timer nobody will see end.
const MAX_TIMER_MS = 24 * 3_600_000

function left(): string {
  return describeDuration(remainingMs(Date.now()))
}

export function startTimerAction(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 1000) {
    return "That timer length didn't make sense - nothing started."
  }
  if (durationMs > MAX_TIMER_MS) return 'Timers can be at most 24 hours - nothing started.'
  const previous = getTimer().status === 'idle' ? null : left()
  start(durationMs)
  const replaced = previous ? ` (replaced the one with ${previous} left)` : ''
  return `Started a ${describeDuration(durationMs)} timer${replaced}.`
}

export function cancelTimerAction(): string {
  if (getTimer().status === 'idle') return "There's no timer running."
  const had = left()
  cancel()
  return `Cancelled the timer (it had ${had} left).`
}

export function pauseTimerAction(): string {
  const state = getTimer()
  if (state.status === 'idle') return "There's no timer running."
  if (state.status === 'paused') return `The timer is already paused, ${left()} left.`
  pause()
  return `Paused the timer with ${left()} left.`
}

export function resumeTimerAction(): string {
  const state = getTimer()
  if (state.status === 'idle') return "There's no timer to resume."
  if (state.status === 'running') return `The timer is already running, ${left()} left.`
  resume()
  return `Resumed the timer, ${left()} left.`
}

export function timerStatusAction(): string {
  const state = getTimer()
  if (state.status === 'idle') return "There's no timer running."
  if (state.status === 'paused') return `The timer is paused with ${left()} left.`
  return `${left()} left on the timer.`
}

function count(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0
}

export const timerActions: AssistantAction[] = [
  {
    declaration: {
      name: 'start_timer',
      description:
        'Start the countdown timer, replacing any timer already running. Give the length ' +
        'in any mix of hours, minutes and seconds.',
      parameters: {
        type: 'OBJECT',
        properties: {
          hours: { type: 'NUMBER' },
          minutes: { type: 'NUMBER' },
          seconds: { type: 'NUMBER' },
        },
      },
    },
    run: async args => {
      const ms =
        count(args.hours) * 3_600_000 + count(args.minutes) * 60_000 + count(args.seconds) * 1000
      return startTimerAction(Math.round(ms))
    },
  },
  {
    declaration: { name: 'cancel_timer', description: 'Cancel the running or paused timer.' },
    run: async () => cancelTimerAction(),
  },
  {
    declaration: { name: 'pause_timer', description: 'Pause the running timer.' },
    run: async () => pauseTimerAction(),
  },
  {
    declaration: { name: 'resume_timer', description: 'Resume a paused timer.' },
    run: async () => resumeTimerAction(),
  },
  {
    declaration: {
      name: 'timer_status',
      description: 'Say how much time is left on the timer, or that none is running.',
    },
    run: async () => timerStatusAction(),
  },
]
