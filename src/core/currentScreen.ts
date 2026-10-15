// One shared fact, kept in sync between the glasses' own navigation
// (app/main.ts) and the phone companion page (companion/main.ts) - not two
// apps talking over a network, just two renderers sharing one piece of
// state in the same JS instance on the same page (see companion/main.ts's
// own note on this).
//
// Per direct instruction: the glasses are the hands-free extension of the
// companion, not a separate app with its own independent place to be - so
// whichever app is open on the glasses, the companion should follow and
// show that same app's (richer) page, not whatever it was last clicked
// into on the phone. This module is the glasses -> companion half of
// that; app/main.ts calls setCurrentScreen whenever its own navigation
// actually changes, companion/main.ts subscribes and re-renders to match.
// The other direction (companion navigation steering the glasses) is not
// built yet - see docs/roadmap.md.
//
// `detail` is deliberately opaque here - this module only has to carry it,
// not understand it. A tool with its own internal depth worth mirroring
// (today, only Chat - see features/chat/tool.ts) defines its own detail
// shape and is the only thing that reads it back on the companion side.
export type CurrentScreen = { kind: 'menu' } | { kind: 'tool'; name: string; detail?: unknown }

let current: CurrentScreen = { kind: 'menu' }
const listeners = new Set<(screen: CurrentScreen) => void>()

export function getCurrentScreen(): CurrentScreen {
  return current
}

export function setCurrentScreen(screen: CurrentScreen): void {
  current = screen
  listeners.forEach(listener => listener(screen))
}

// Returns an unsubscribe function, same shape as bridge.onEvenHubEvent's
// own return value elsewhere in this app.
export function onCurrentScreenChange(listener: (screen: CurrentScreen) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
