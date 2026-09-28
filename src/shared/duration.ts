// Pure formatting, no SDK access - shared between the Timer tool's own
// countdown display and the status bar's shrunk version of the same number,
// so the two can never drift into showing different digits for the same
// millisecond value.
//
// h:mm:ss once there is an hour to show, m:ss otherwise - a plain stopwatch
// read rather than zero-padded to a fixed width, since nothing here lines up
// in a column the way the status bar's own clock does.
export function formatDuration(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}
