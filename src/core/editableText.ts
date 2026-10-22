import { bridge, status } from '../platform/bridge'

// A Settings text that starts as a default and is the wearer's to change
// (G2-145): Jarvis's instructions and the mode presets. Three states:
// - never saved, or reset: the default (an empty stored value);
// - saved: the wearer's text;
// - deleted: saved empty on purpose - no text at all, NOT the default,
//   so deleting really deletes. Stored as a marker, since an empty value
//   already means "use the default".
const DELETED = '[deleted]'

export async function readEditable(key: string, fallback: string): Promise<string> {
  try {
    const raw = (await bridge.getLocalStorage(key)).trim()
    if (!raw) return fallback
    return raw === DELETED ? '' : raw
  } catch {
    return fallback
  }
}

export async function writeEditable(
  key: string,
  text: string,
  max: number,
  what: string,
): Promise<boolean> {
  const trimmed = text.trim()
  const ok = await bridge.setLocalStorage(key, trimmed ? trimmed.slice(0, max) : DELETED)
  if (!ok) status(`Failed to save ${what}`)
  return ok
}

export async function resetEditable(key: string, what: string): Promise<boolean> {
  const ok = await bridge.setLocalStorage(key, '')
  if (!ok) status(`Failed to reset ${what}`)
  return ok
}
