import { PAGE_INNER_WIDTH, currentPageRows, tailRows } from './paging'
import { leadSentenceEnd, nextShown } from './typing'
import { charsPerSecond, type AnswerSpeed } from '../../shared/readingStyle'
import { moveView, rowsOf, tailWin, viewLabel, type Win } from './viewer'

// THE ANSWER BEING TYPED (G2-106, G2-107, G2-110, G2-111), split out of
// tool.ts in G2-172. The answer is revealed at a readable pace
// (features/chat/typing.ts), as its last screenful - newest line at the
// bottom - which is one screen, so there is nothing to scroll or jump.
//   follow: the typed last screenful. Tap pauses; swipe up pauses and goes
//           back a window.
//   hold:   paused, free to read up and down over what has arrived so far
//           (see PAUSED below). Tap goes on typing.
// tool.ts owns the screen and hands it in as a StreamScreen.

export type Stream = {
  header: string
  label: string
  received: string
  shown: number
  budget: number
  lastTickAt: number
  complete: boolean
  fast: boolean
  mode: 'follow' | 'hold'
  timer: ReturnType<typeof setInterval> | null
  drawn: string
  relevant: () => boolean
  release: (() => void) | null
  // The window being read while paused.
  win: Win | null
  // Show the first sentence whole as soon as it arrives (G2-180).
  sayNow?: boolean
  // Set when the typing caught up with the model by itself; unset if it was
  // cut short (left, backgrounded).
  outcome?: 'caught-up'
  // The last update sent to the glasses: the next must wait for it, as two
  // content updates in flight at once can be rejected.
  pending: Promise<unknown>
}

// What the typing needs from the screen (tool.ts).
export type StreamScreen = {
  setContent(text: string): Promise<unknown>
  // The status bar hint (tool.ts keeps the follow-up prompt over it).
  setNote(note: string | null): void
  // A paused window of rows; setWin follows a re-layout.
  showWindow(rows: string[], win: Win, setWin: (w: Win) => void): Promise<unknown>
  // The scroll cooldown shared with page turning; true when a swipe counts.
  takeScroll(): boolean
  // The stream on screen ended: the status bar goes back to the page note.
  onEnded(): void
  // Typing goes on: the paged view of the finished answer is stale.
  onResumed(): void
}

let screen: StreamScreen | null = null

// How fast answers appear (G2-197, a Display setting).
let answerSpeed: AnswerSpeed = 'normal'

export function setAnswerSpeed(speed: AnswerSpeed): void {
  answerSpeed = speed
}

// Instant answers end on their first page, not on the last lines.
export function isInstant(): boolean {
  return answerSpeed === 'instant'
}
let current: Stream | null = null

export function useScreen(s: StreamScreen): void {
  screen = s
}

// The answer being typed on screen now, if any.
export function currentStream(): Stream | null {
  return current
}

export function setCurrentStream(s: Stream): void {
  current = s
}

// The wearer-facing hint in the middle of the status bar.
export function streamNote(s: Stream): string | null {
  if (s.mode === 'hold') {
    const rows = allRows(s)
    const win = s.win ?? tailWin(rows)
    return viewLabel(rows, win)
  }
  // Typing: no position yet; the hint row says what a tap does (G2-178).
  return null
}

function drawStream(s: Stream): void {
  if (current !== s) return
  if (s.mode === 'follow' && answerSpeed === 'instant') {
    // Instant (G2-197): the answer's first page from the top, growing as it
    // arrives; once that page is full nothing changes, so nothing moves.
    const head = rowsOf(s.received, PAGE_INNER_WIDTH).slice(0, currentPageRows()).join('\n')
    if (head && head !== s.drawn) {
      s.drawn = head
      s.pending = s.pending.then(() => screen?.setContent(head))
    }
  } else if (s.mode === 'follow') {
    const tail = tailRows(s.received.slice(0, s.shown), PAGE_INNER_WIDTH)
    if (tail && tail !== s.drawn) {
      s.drawn = tail
      s.pending = s.pending.then(() => screen?.setContent(tail))
    }
  }
  screen?.setNote(streamNote(s))
}

export function tickStream(s: Stream): void {
  if (current !== s) return
  if (!s.relevant()) {
    endStream(s)
    return
  }
  const now = Date.now()
  const elapsed = now - s.lastTickAt
  s.lastTickAt = now
  if (s.mode === 'follow') {
    // Only typing time counts: a pause must not store up time that is then
    // spent in one burst on resuming (G2-110).
    s.budget += (charsPerSecond(answerSpeed) * elapsed) / 1000
    if (answerSpeed === 'instant') s.shown = s.received.length
    // Interview and Code: the first sentence at once, to say now (G2-180).
    if (s.sayNow) {
      const lead = leadSentenceEnd(s.received)
      if (lead > s.shown) {
        s.shown = lead
        s.budget = 0
      }
    }
    const next = nextShown(s.received, s.shown, s.fast ? Infinity : s.budget, s.complete)
    if (next > s.shown) {
      s.budget = s.fast ? 0 : Math.max(0, s.budget - (next - s.shown))
      s.shown = next
    }
    drawStream(s)
    if (s.complete && s.shown >= s.received.length) {
      s.outcome = 'caught-up'
      s.release?.()
    }
  } else {
    drawStream(s)
  }
}

export function endStream(s: Stream): void {
  if (s.timer !== null) clearInterval(s.timer)
  s.timer = null
  s.release?.()
  s.release = null
  if (current === s) {
    current = null
    screen?.onEnded()
  }
}

// The model has finished: wait until the typing has caught up, or - if the
// wearer stopped following - until they tap.
export function waitForReveal(s: Stream): Promise<void> {
  return new Promise<void>(resolve => {
    s.release = resolve
    tickStream(s)
  }).then(() => s.pending.then(() => undefined))
}

// PAUSED (G2-107): a tap while the answer is being typed leaves the screen
// exactly as it is. The wearer then reads freely over everything that has
// arrived so far, in windows (features/chat/viewer.ts): smooth scrolling
// inside a window, a swipe past its edge moves to the next or previous one,
// and a swipe down past the last window waits for more to arrive. Tap again
// to go on typing from where they have read to.
function allRows(s: Stream): string[] {
  return rowsOf(s.received, PAGE_INNER_WIDTH)
}

export function freezeStream(): Stream | null {
  const s = current
  // Instant (G2-197): nothing to pause, and pausing jumps to the newest line.
  if (!s || s.timer === null || s.mode !== 'follow' || answerSpeed === 'instant') return null
  s.mode = 'hold'
  s.win = tailWin(rowsOf(s.received.slice(0, s.shown), PAGE_INNER_WIDTH))
  screen?.setNote(streamNote(s))
  return s
}

export function moveHold(s: Stream, delta: -1 | 1): void {
  if (!screen?.takeScroll()) return
  const rows = allRows(s)
  const next = moveView(rows, s.win ?? tailWin(rows), delta)
  if (!next) {
    // Down past the last line: go on to the end at full speed (G2-111).
    if (delta === 1) skipToEnd(s)
    return
  }
  s.win = next
  const shown = screen
  s.pending = s.pending.then(() => shown.showWindow(rows, next, w => (s.win = w)))
}

function resumeStream(s: Stream): void {
  // Carries on from exactly where the typing paused (G2-110), not from where
  // the wearer scrolled to: reading ahead is allowed, but the typing must not
  // jump to the latest words.
  s.mode = 'follow'
  s.win = null
  s.drawn = ''
  s.budget = 0
  s.lastTickAt = Date.now()
  screen?.onResumed()
  tickStream(s)
}

// Jump to the end of the answer at full speed (G2-111): a swipe down while
// it is typing, or down past the last line while paused. The screen then
// stays on the last lines, as when the typing finishes by itself.
export function skipToEnd(s: Stream): void {
  s.fast = true
  if (s.mode === 'hold') resumeStream(s)
  else tickStream(s)
}

// A tap while the answer is being typed: pause, or go on. True if used.
export function tapStream(): boolean {
  const s = current
  if (!s || s.timer === null) return false
  if (answerSpeed === 'instant') return true
  if (s.mode === 'follow') freezeStream()
  else resumeStream(s)
  return true
}
