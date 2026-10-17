import { bridge, status } from '../platform/bridge'

// Whether "Hey Jarvis" listening is on (G2-64). On unless the wearer turns
// it off on the companion page - it is the point of the feature - but it
// holds the glasses mic for as long as the app is open, so the switch is
// there for battery and privacy. The companion page and the glasses app
// run in the same page, so a change reaches app/main.ts directly through
// onWakeSettingChanged and takes effect at once.
const STORAGE_KEY = 'jarvis.wakeWord'

export async function isWakeWordEnabled(): Promise<boolean> {
  try {
    return (await bridge.getLocalStorage(STORAGE_KEY)) !== 'off'
  } catch {
    return true
  }
}

let changeListener: ((enabled: boolean) => void) | null = null

export function onWakeSettingChanged(fn: (enabled: boolean) => void): void {
  changeListener = fn
}

export async function setWakeWordEnabled(enabled: boolean): Promise<boolean> {
  const ok = await bridge.setLocalStorage(STORAGE_KEY, enabled ? 'on' : 'off')
  if (!ok) status('Failed to save the "Hey Jarvis" setting')
  changeListener?.(enabled)
  return ok
}
