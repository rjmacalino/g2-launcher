import { bridge, status } from '../platform/bridge'
import type { CodeSize } from '../ui/codeRender'

// How big code is drawn in Jarvis's code view on the glasses (G2-73), set
// on the phone. Read once at startup and kept in memory, so opening the
// code view never waits on storage.
const STORAGE_KEY = 'glasses.codeSize'
const SIZES: readonly CodeSize[] = ['small', 'medium', 'large']

let current: CodeSize = 'medium'

void bridge
  .getLocalStorage(STORAGE_KEY)
  .then(stored => {
    if (SIZES.includes(stored as CodeSize)) current = stored as CodeSize
  })
  .catch(() => {})

export function getCodeSize(): CodeSize {
  return current
}

export async function setCodeSize(size: CodeSize): Promise<boolean> {
  current = size
  const ok = await bridge.setLocalStorage(STORAGE_KEY, size)
  if (!ok) status('Failed to save the code size')
  return ok
}
