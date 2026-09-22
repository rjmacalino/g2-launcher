import { STORAGE_KEY_SCREEN, readJson, writeKey } from './storage'
import { TOOLS } from './tools'

// Which page is showing. A discriminated union, not `number | null`, because
// index 0 is falsy, so an `if (currentToolIndex)` check would treat "the first
// tool is open" as "no tool is open". `kind` has no such trap.
export type Screen = { kind: 'menu' } | { kind: 'tool'; index: number }

// How recently the screen must have changed for a cold start to restore it. Long
// enough to cover a lock-screen resume (the Beta criterion locks the phone for 5
// minutes), short enough that a deliberate relaunch the next morning lands on the
// menu.
const RESTORE_WINDOW_MS = 30 * 60 * 1000

// On Android the WebView can be suspended under memory pressure and the module
// re-runs on resume, so in-memory state is lost. The current screen is persisted
// eagerly and restored on startup if it is recent enough to be a resume rather
// than a fresh launch.
//
// The timestamp answers "how long ago was the wearer last on this page?" A cold
// start picks the value up and compares against RESTORE_WINDOW_MS. Below the
// window, restore. Above it, start on the menu as usual.
export function persistScreen(s: Screen) {
  const payload = JSON.stringify({
    kind: s.kind,
    index: s.kind === 'tool' ? s.index : null,
    at: Date.now(),
  })
  writeKey(STORAGE_KEY_SCREEN, payload, 'Failed to persist screen')
}

// Parse the persisted screen. Returns null on any failure or if the value is
// stale by RESTORE_WINDOW_MS. The caller falls back to the menu.
export async function readStoredScreen(): Promise<Screen | null> {
  const parsed = await readJson(STORAGE_KEY_SCREEN)
  if (!parsed) return null
  if (typeof parsed.at !== 'number') return null
  if (Date.now() - parsed.at > RESTORE_WINDOW_MS) return null
  if (parsed.kind === 'menu') return { kind: 'menu' }
  if (parsed.kind === 'tool') {
    const i = parsed.index
    if (typeof i !== 'number' || i < 0 || i >= TOOLS.length) return null
    return { kind: 'tool', index: i }
  }
  return null
}
