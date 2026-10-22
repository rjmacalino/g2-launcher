import { bridge, status } from '../platform/bridge'

// Jarvis's modes (G2-139): one assistant, with a style picked per chat.
// A mode is only extra instructions, sent after "Instructions for Jarvis"
// (core/localInstructions.ts), which every mode shares. Auto adds nothing:
// a capable model adapts to the topic by itself. Each preset is the
// wearer's to edit in Settings; clearing one goes back to its default here.

import { MODES, modeOf, type ModeId } from '../shared/modePresets'

export { MODES, modeOf }
export type { Mode, ModeId } from '../shared/modePresets'

export const MODE_PRESET_MAX_CHARS = 5000

const key = (id: ModeId) => `jarvis.mode.${id}`

// The preset as the wearer saved it, or the default.
export async function getModePreset(id: ModeId): Promise<string> {
  try {
    const saved = (await bridge.getLocalStorage(key(id))).trim()
    return saved || modeOf(id).preset
  } catch {
    return modeOf(id).preset
  }
}

export async function setModePreset(id: ModeId, text: string): Promise<boolean> {
  const ok = await bridge.setLocalStorage(key(id), text.trim().slice(0, MODE_PRESET_MAX_CHARS))
  if (!ok) status(`Failed to save the ${modeOf(id).label} mode`)
  return ok
}
