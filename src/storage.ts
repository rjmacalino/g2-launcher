import { bridge, status } from './bridge'

// Dotted namespace so per-tool keys stay grouped.
export const STORAGE_KEY_TELEPROMPTER = 'teleprompter.line'
export const STORAGE_KEY_SCREEN = 'ui.screen'
export const STORAGE_KEY_STATUS_BAR = 'ui.statusbar'

// Ceiling on how long we wait for a storage read before giving up and using the
// fallback. Storage reads resolve in milliseconds; a hang means the host is not
// answering, and every caller here has a fallback that is always safe.
export const STORAGE_READ_TIMEOUT_MS = 5000

// Race any startup read against a timeout.
//
// try/catch covers a rejection. It does nothing for a promise that never settles,
// and the two are indistinguishable from here. Startup awaits these reads before
// registering the event handler, so a read that hangs forever leaves the menu
// drawn and nothing listening: an app that looks healthy and ignores every
// gesture, including the root double tap that submission QA requires to work.
//
// Anything awaited on that stretch goes through here.
export function readWithTimeout<T>(read: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    read,
    new Promise<T>(resolve => {
      setTimeout(() => resolve(fallback), STORAGE_READ_TIMEOUT_MS)
    }),
  ])
}

export function writeKey(key: string, value: string, failureNote: string) {
  bridge.setLocalStorage(key, value).then(ok => {
    if (!ok) status(failureNote)
  })
}

// Read and JSON.parse a key. Returns null on a missing key, malformed JSON, or a
// value that is not an object, so every caller has one shape to handle rather
// than three.
export async function readJson(key: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await bridge.getLocalStorage(key)
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}
