import { PAGE_INNER_WIDTH, SCREEN_ROWS, wrapLines } from './paging'

// The listening screen's text (G2-136, G2-157, G2-158, G2-164), split out of
// tool.ts in G2-174 so it can be tested: who is listening and for how long,
// how the question will be sent, then the newest rows of the live captions,
// so the latest words are always on screen and nothing needs scrolling.
// Pure.

export type ListeningInfo = {
  // "Gemini Live", "Deepgram (not connected)", "Whisper"...
  engine: string
  dots: string
  seconds: number
  // The auto-send setting in seconds, 0 when off.
  autoSend: number
  // Seconds left before auto-send, null when off (see shared/voiceFlow.ts).
  countdown: number | null
}

export function listeningHeader(info: ListeningInfo): string {
  const first = `${info.engine} listening${info.dots} (${info.seconds}s)`
  if (info.countdown !== null) return `${first}\nSending in ${info.countdown}s, or tap to send now`
  const hint = info.autoSend > 0 ? `Tap to send, or stay quiet ${info.autoSend}s` : 'Tap to send'
  return `${first}\n${hint}`
}

// The header, a blank row, then as many of the newest caption rows as fit.
export function listeningText(header: string, heard: string): string {
  const headerRows = header.split('\n').length + 1
  const rows = heard ? wrapLines(heard, PAGE_INNER_WIDTH).slice(-(SCREEN_ROWS - headerRows)) : []
  return rows.length > 0 ? `${header}\n\n${rows.join('\n')}` : header
}

// A cycling ". .. ..." plus an elapsed-seconds counter, redrawn every second
// (per direct request: the counter is the "is this alive" signal). Only one
// runs at a time: starting one stops the last, since a leaked interval is a
// screen update every second, forever. isStale stops it once the recording
// or question that started it has moved on.
const STATUS_FRAMES = ['.', '..', '...']
const STATUS_TICK_MS = 1000
let stopActive: (() => void) | null = null

export function startTicker(
  isStale: () => boolean,
  render: (dots: string, elapsedSeconds: number) => void,
  startedAt = Date.now(),
): () => void {
  stopActive?.()
  let frame = 0
  const tick = () => {
    if (isStale()) {
      stop()
      return
    }
    render(STATUS_FRAMES[frame], Math.floor((Date.now() - startedAt) / 1000))
    frame = (frame + 1) % STATUS_FRAMES.length
  }
  const interval = setInterval(tick, STATUS_TICK_MS)
  const stop = () => {
    clearInterval(interval)
    if (stopActive === stop) stopActive = null
  }
  stopActive = stop
  tick()
  return stop
}

// Whether a ticker is running (the Listening or Thinking counter).
export function tickerRunning(): boolean {
  return stopActive !== null
}

export function stopTicker(): void {
  stopActive?.()
}
