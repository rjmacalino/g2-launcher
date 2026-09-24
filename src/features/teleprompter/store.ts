import { bridge, status } from '../../platform/bridge'
import { makeCollection } from '../../platform/collection'

export type { Item as Script } from '../../platform/collection'

export const scripts = makeCollection('scripts.list')

// Which saved script the teleprompter currently shows. A separate key rather
// than a field on the script itself, because "currently active" is a property
// of the teleprompter tool, not of the script, and a script should not need
// editing just to stop being the active one.
const ACTIVE_SCRIPT_KEY = 'scripts.activeId'

export async function getActiveScriptId(): Promise<string | null> {
  try {
    const raw = await bridge.getLocalStorage(ACTIVE_SCRIPT_KEY)
    // Every plausible representation of "nothing stored" collapses to null
    // here, same defensive shape as readStoredLine in the teleprompter's
    // earlier position-tracking code: empty string, and the literal strings
    // a host might return for an unset key.
    if (!raw || raw === 'null' || raw === 'undefined') return null
    return raw
  } catch {
    return null
  }
}

export function setActiveScriptId(id: string): Promise<boolean> {
  return bridge.setLocalStorage(ACTIVE_SCRIPT_KEY, id).then(ok => {
    if (!ok) status('Failed to set active script')
    return ok
  })
}
