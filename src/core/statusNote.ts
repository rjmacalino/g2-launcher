// A short note a tool puts in the middle of the status bar, in place of the
// weather (G2-102): where the wearer is in a long answer or in code. A
// registered handler rather than an import of app/statusbar.ts, the same
// way core/rebuild.ts keeps tools from importing the shell. null clears it.
let handler: ((text: string | null) => void) | null = null

export function registerStatusNoteHandler(fn: (text: string | null) => void): void {
  handler = fn
}

export function setStatusNote(text: string | null): void {
  handler?.(text)
}
