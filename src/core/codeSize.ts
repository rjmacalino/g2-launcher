import { bridge, status } from '../platform/bridge'

// How big code is drawn in the glasses' code view (G2-125), chosen on the
// companion page. Kept in memory once loaded, because drawing code asks for
// it synchronously; the saved value is read once at startup. A change takes
// effect the next time a code view is opened.
export const CODE_SIZES = [12, 14, 16, 18] as const
export const DEFAULT_CODE_SIZE = 14
const STORAGE_KEY = 'jarvis.codeSize'

let current: number = DEFAULT_CODE_SIZE

export function getCodeSize(): number {
  return current
}

export async function loadCodeSize(): Promise<void> {
  try {
    const saved = Number(await bridge.getLocalStorage(STORAGE_KEY))
    if ((CODE_SIZES as readonly number[]).includes(saved)) current = saved
  } catch {
    // Keep the default.
  }
}

export async function setCodeSize(size: number): Promise<boolean> {
  if (!(CODE_SIZES as readonly number[]).includes(size)) return false
  current = size
  const ok = await bridge.setLocalStorage(STORAGE_KEY, String(size))
  if (!ok) status('Failed to save the code size')
  return ok
}
