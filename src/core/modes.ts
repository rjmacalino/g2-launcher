import { readEditable, resetEditable, writeEditable } from './editableText'

// Jarvis's modes (G2-139): one assistant, with a style picked per chat.
// A mode is only extra instructions, sent after "Instructions for Jarvis"
// (core/localInstructions.ts), which every mode shares. Auto adds nothing:
// a capable model adapts to the topic by itself. Each preset is the
// wearer's to edit, delete or reset in Settings (core/editableText.ts).

import { MODES, modeOf, type ModeId } from '../shared/modePresets'

export { MODES, modeOf }
export type { Mode, ModeId } from '../shared/modePresets'

export const MODE_PRESET_MAX_CHARS = 5000

const key = (id: ModeId) => `jarvis.mode.${id}`

// The preset as the wearer saved it, deleted (empty), or the default.
export function getModePreset(id: ModeId): Promise<string> {
  return readEditable(key(id), modeOf(id).preset)
}

export function setModePreset(id: ModeId, text: string): Promise<boolean> {
  return writeEditable(key(id), text, MODE_PRESET_MAX_CHARS, `the ${modeOf(id).label} mode`)
}

export function resetModePreset(id: ModeId): Promise<boolean> {
  return resetEditable(key(id), `the ${modeOf(id).label} mode`)
}
