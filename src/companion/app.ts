import type { CurrentScreen } from '../core/currentScreen'

// The phone app's places and the contract between its shell (main.ts) and
// its four tabs (views/*.ts) (G2-71). The phone is the full app and the
// glasses its hands-free extension: every route says which glasses
// screen, if any, matches it, so moving on either side moves the other.

export type Route =
  | { tab: 'jarvis'; chatId?: string }
  | { tab: 'live' }
  | { tab: 'notes'; noteId?: string }
  | { tab: 'settings' }

// What a tab hands the shell to show.
export type Page = {
  title: string
  // A back button to this route, for pages below a tab's top level.
  back?: Route
  actions?: HTMLElement[]
  body: HTMLElement
  // Pinned between the content and the tab bar - the chat composer.
  footer?: HTMLElement
  // Open scrolled to the bottom (a conversation, a transcript).
  scrollToEnd?: boolean
  // Called when the page is replaced: unsubscribe, stop timers. leaving
  // is false for an in-place refresh of the same page.
  cleanup?: (leaving: boolean) => void
}

export type AppContext = {
  navigate(route: Route, options?: { replace?: boolean }): void
  glassesConnected(): boolean
  // Ask the glasses to show something without changing the phone's page -
  // starting Jarvis Live, ending it.
  requestGlasses(screen: CurrentScreen): void
  // Redraw the current page in place, keeping its scroll position.
  refresh(): void
}

export type View = (ctx: AppContext, route: Route) => Page

// "New chat": a conversation that does not exist until its first question.
export const NEW_CHAT = 'new'

export function routeToScreen(route: Route): CurrentScreen | null {
  switch (route.tab) {
    case 'jarvis':
      return route.chatId && route.chatId !== NEW_CHAT
        ? {
            kind: 'tool',
            name: 'Jarvis',
            detail: { depth: 'conversation', sessionId: route.chatId },
          }
        : { kind: 'tool', name: 'Jarvis', detail: { depth: 'picker' } }
    case 'notes':
      return route.noteId
        ? { kind: 'tool', name: 'Notes', detail: { noteId: route.noteId } }
        : { kind: 'tool', name: 'Notes' }
    // Viewing Live or Settings on the phone does not move the glasses;
    // Live is started and ended with its own buttons.
    default:
      return null
  }
}

export function screenToRoute(screen: CurrentScreen): Route | null {
  if (screen.kind !== 'tool') return null
  const detail = (screen.detail ?? {}) as Record<string, unknown>
  switch (screen.name) {
    case 'Jarvis':
      if (detail.depth === 'conversation') {
        return {
          tab: 'jarvis',
          chatId: typeof detail.sessionId === 'string' ? detail.sessionId : NEW_CHAT,
        }
      }
      return { tab: 'jarvis' }
    case 'Notes':
      return typeof detail.noteId === 'string'
        ? { tab: 'notes', noteId: detail.noteId }
        : { tab: 'notes' }
    case 'Jarvis Live':
      return { tab: 'live' }
    default:
      return null
  }
}

export function sameRoute(a: Route, b: Route): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
