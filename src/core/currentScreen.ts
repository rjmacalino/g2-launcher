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
//
// The other half (G2-69): requestScreen is the companion asking the
// glasses to go somewhere - opening Notes or a list on the phone opens it
// on the glasses too. app/main.ts handles the request with the same
// navigation a gesture would use, and the result comes back through
// setCurrentScreen like any other move, so both sides always agree.
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
  // A copy: a listener that unsubscribes and resubscribes while being
  // called (a page redrawing itself) would otherwise be called again, forever.
  for (const listener of [...listeners]) listener(screen)
}

// Returns an unsubscribe function, same shape as bridge.onEvenHubEvent's
// own return value elsewhere in this app.
export function onCurrentScreenChange(listener: (screen: CurrentScreen) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

let requestHandler: ((screen: CurrentScreen) => void) | null = null

// Registered once by app/main.ts, which owns glasses navigation.
export function onScreenRequest(fn: (screen: CurrentScreen) => void): void {
  requestHandler = fn
}

// The companion asking the glasses to show this screen. `detail` uses the
// same shape the tool itself publishes (its screenDetail - see
// core/tool.ts), so "where the glasses are" and "where to go" are written
// the same way.
export function requestScreen(screen: CurrentScreen): void {
  requestHandler?.(screen)
}

// For a tool whose internal place changed without the shell knowing (a
// list opened, a conversation picked): republishes it with its current
// detail.
export function publishToolScreen(tool: { name: string; screenDetail?(): unknown }): void {
  setCurrentScreen({ kind: 'tool', name: tool.name, detail: tool.screenDetail?.() })
}
