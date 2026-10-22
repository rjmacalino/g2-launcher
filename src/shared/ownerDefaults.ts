import defaults from '../defaults/instructions.json'

// The owner's starting values for the Settings boxes (G2-148): their own
// instructions and the profile Interview mode answers from. Personal, so
// they live in src/defaults/owner.local.json, which is gitignored and only
// ever on the owner's machine; the repo carries the neutral "owner" in
// instructions.json, used when that file is missing (a fresh clone, CI, or
// Node scripts, where Vite's import.meta.glob does not exist).

type Owner = { instructions: string; profile: string }

const local: Owner | undefined =
  typeof import.meta.glob === 'function'
    ? Object.values(
        import.meta.glob<{ default: Owner }>('../defaults/owner.local.json', { eager: true }),
      )[0]?.default
    : undefined

export const OWNER: Owner = local ?? defaults.owner
