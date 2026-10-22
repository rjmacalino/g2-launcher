import { OWNER } from './ownerDefaults'

// The default "Instructions for Jarvis" (G2-95, G2-138): what Settings
// shows until the wearer saves their own. Kept apart from
// core/localInstructions.ts (which reads the phone's storage) so the PC
// benchmarks can use it too.

// Used until the wearer saves their own (or deletes it); Reset to default
// in Settings brings it back. The text is in src/defaults/instructions.json.
export const DEFAULT_LOCAL_INSTRUCTIONS = OWNER.instructions
