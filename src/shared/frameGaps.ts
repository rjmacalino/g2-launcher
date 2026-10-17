// Tracks the time between consecutive events of a stream that should
// arrive at a steady rate - the glasses mic sends one every 100 ms - and
// counts the dropouts. Pure: the caller passes the clock in.
export function createFrameTracker(gapThresholdMs: number) {
  let lastAt: number | null = null
  let longestGapMs = 0
  let gapCount = 0
  return {
    onFrame(now: number) {
      if (lastAt !== null) {
        const gap = now - lastAt
        if (gap > longestGapMs) longestGapMs = gap
        if (gap > gapThresholdMs) gapCount += 1
      }
      lastAt = now
    },
    longestGapMs: () => longestGapMs,
    gapCount: () => gapCount,
  }
}
