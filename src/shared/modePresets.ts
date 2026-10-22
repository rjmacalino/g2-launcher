import defaults from '../defaults/instructions.json'
import { OWNER } from './ownerDefaults'

// Jarvis's modes (G2-139); their default presets are in
// src/defaults/instructions.json (G2-146). Kept apart from
// core/modes.ts (which reads the phone's storage) so the PC benchmarks can
// use them too.

export type ModeId = 'auto' | 'interview' | 'coding' | 'general'

export type Mode = { id: ModeId; label: string; preset: string }

export const MODES: readonly Mode[] = [
  { id: 'auto', label: 'Auto', preset: '' },
  {
    id: 'interview',
    label: 'Interview',
    // The owner's facts follow the preset, so Interview answers are theirs.
    preset: [defaults.modes.interview, OWNER.profile].filter(Boolean).join('\n\n'),
  },
  { id: 'coding', label: 'Coding', preset: defaults.modes.coding },
  { id: 'general', label: 'General', preset: defaults.modes.general },
]

export function modeOf(id: string | undefined): Mode {
  return MODES.find(m => m.id === id) ?? MODES[0]
}
