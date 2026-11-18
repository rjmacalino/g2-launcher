// Auto-send when quiet (G2-158): off by default, since a question sent
// before it was finished wastes an AI request; or after this many seconds
// of quiet. With it off, a recording ends on a tap.
export const AUTO_SEND_SECONDS = [5, 10, 15, 20] as const

// The saved choice in seconds; 0 (off) for anything else.
export function parseAutoSend(saved: string): number {
  const seconds = Number(saved)
  return (AUTO_SEND_SECONDS as readonly number[]).includes(seconds) ? seconds : 0
}
