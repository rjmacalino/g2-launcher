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
    // Behavioural (G2-152): the owner's facts follow the preset, so the
    // answers are theirs.
    preset: [defaults.modes.interview, OWNER.profile].filter(Boolean).join('\n\n'),
  },
  {
    id: 'coding',
    label: 'Coding',
    // The technical interview: the think-aloud script plus the LeetCode and
    // HackerRank rules (G2-151, G2-152).
    preset: [defaults.modes.coding, defaults.codingProblems].join('\n\n'),
  },
  { id: 'general', label: 'General', preset: defaults.modes.general },
]

export function modeOf(id: string | undefined): Mode {
  return MODES.find(m => m.id === id) ?? MODES[0]
}
