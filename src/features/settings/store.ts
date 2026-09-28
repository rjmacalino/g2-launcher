import { STORAGE_KEY_STATUS_BAR, readJson, readWithTimeout, writeKey } from '../../platform/storage'

// Which status bar fields are on. Lives here rather than in app/statusbar.ts
// (which owns rendering and used to own this too) because the Settings tool
// needs to read and write it, and features/* is not allowed to import from
// app/* - see docs/roadmap.md's target structure. app/statusbar.ts imports
// this module instead, the same direction it already imports
// features/weather/conditions.
export type StatusBarConfig = {
  time: boolean
  date: boolean
  temperature: boolean
}

// Temperature defaults on: Weather fetches real conditions now, not a
// placeholder, so leaving this off by default would mean the centre slot
// stays silently blank on every device forever, since nothing else ever
// flips it on.
const DEFAULTS: StatusBarConfig = {
  time: true,
  date: true,
  temperature: true,
}

let config: StatusBarConfig = { ...DEFAULTS }

const listeners = new Set<() => void>()

export function onUpdate(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notify() {
  for (const fn of listeners) fn()
}

// Any failure falls back to defaults rather than an empty bar: a wearer who
// has never opened Settings should still get a clock, and a corrupt value
// should not produce a blank strip they cannot explain.
async function readConfig(): Promise<StatusBarConfig> {
  const parsed = await readJson(STORAGE_KEY_STATUS_BAR)
  if (!parsed) return { ...DEFAULTS }
  return {
    time: typeof parsed.time === 'boolean' ? parsed.time : DEFAULTS.time,
    date: typeof parsed.date === 'boolean' ? parsed.date : DEFAULTS.date,
    temperature:
      typeof parsed.temperature === 'boolean' ? parsed.temperature : DEFAULTS.temperature,
  }
}

export async function hydrate(): Promise<void> {
  config = await readWithTimeout(readConfig(), { ...DEFAULTS })
}

export function getConfig(): StatusBarConfig {
  return config
}

export function setField(field: keyof StatusBarConfig, value: boolean) {
  config = { ...config, [field]: value }
  writeKey(STORAGE_KEY_STATUS_BAR, JSON.stringify(config), 'Failed to save status bar config')
  notify()
}
