import './styles.css'
import { bridge } from '../platform/bridge'
import {
  getCurrentScreen,
  onCurrentScreenChange,
  requestScreen,
  type CurrentScreen,
} from '../core/currentScreen'
import {
  routeToScreen,
  sameRoute,
  screenToRoute,
  type AppContext,
  type Page,
  type Route,
} from './app'
import { h, icon, isTyping } from './dom'
import { jarvisView } from './views/jarvis'
import { liveView } from './views/live'
import { notesView } from './views/notes'
import { settingsView } from './views/settings'

// The phone app (G2-71): the full version of everything, usable with no
// glasses at all, with the glasses as its hands-free extension. It runs in
// the same page as the code driving the glasses (see platform/bridge.ts),
// so the two share state directly - no server, no network between them.
//
// Two-way: moving here asks the glasses to show the same thing
// (core/currentScreen.ts's requestScreen, when they are connected and the
// place has a glasses equivalent), and moving on the glasses brings this
// app along - unless someone is typing here, when a banner offers to
// follow instead of throwing the typing away.

const root = document.getElementById('companion')
if (!root) throw new Error('companion root element missing from index.html')

const TABS: { tab: Route['tab']; label: string; icon: string }[] = [
  { tab: 'jarvis', label: 'Jarvis', icon: 'jarvis' },
  { tab: 'live', label: 'Live', icon: 'live' },
  { tab: 'notes', label: 'Notes', icon: 'notes' },
  { tab: 'settings', label: 'Settings', icon: 'settings' },
]

let route: Route = { tab: 'jarvis' }
let page: Page | null = null
let content: HTMLElement | null = null
let connected = true
// The banner's offer: where the glasses went while someone was typing.
let follow: Route | null = null
// The last place the glasses announced, so a re-announcement of the same
// place (Jarvis republishes on every answer) is not taken as a move.
let glassesKey = ''
// A place this app just asked the glasses for, so the glasses announcing it
// back is not taken as the glasses moving on their own.
let expectedKey: string | null = null

function screenKey(screen: CurrentScreen): string {
  return JSON.stringify(screen)
}

function viewFor(next: Route): Page {
  switch (next.tab) {
    case 'live':
      return liveView(ctx)
    case 'notes':
      return notesView(ctx, next)
    case 'settings':
      return settingsView(ctx)
    default:
      return jarvisView(ctx, next)
  }
}

function pill(): HTMLElement {
  const screen = getCurrentScreen()
  const where = !connected
    ? 'Glasses off'
    : screen.kind === 'tool'
      ? `Glasses: ${screen.name}`
      : 'Glasses: menu'
  return h(
    'button',
    {
      class: `glasses-pill${connected ? ' on' : ''}`,
      'aria-label': where,
      onclick: () => {
        const target = screenToRoute(getCurrentScreen())
        if (connected && target) navigate(target)
        else navigate({ tab: 'settings' })
      },
    },
    h('span', { class: 'dot' }),
    where,
  )
}

function render(refresh = false): void {
  const previous = content
  const nearEnd =
    previous !== null && previous.scrollHeight - previous.scrollTop - previous.clientHeight < 80
  const scrollTop = previous?.scrollTop ?? 0
  page?.cleanup?.(!refresh)
  page = viewFor(route)
  const current = page

  const header = h(
    'header',
    { class: 'app-header' },
    current.back
      ? h(
          'button',
          {
            class: 'icon-button',
            'aria-label': 'Back',
            onclick: () => current.back && navigate(current.back),
          },
          icon('back'),
        )
      : null,
    h('h1', {}, current.title),
    ...(current.actions ?? []),
    pill(),
  )

  const banner = follow
    ? h(
        'div',
        { class: 'banner' },
        h('span', {}, 'The glasses moved to another screen.'),
        h(
          'button',
          {
            class: 'button',
            onclick: () => {
              const target = follow
              follow = null
              if (target) navigate(target)
            },
          },
          'Follow',
        ),
      )
    : null

  content = h(
    'main',
    { class: `app-content${current.footer ? ' with-composer' : ''}` },
    current.body,
  )

  const tabbar = h(
    'nav',
    { class: 'tabbar', 'aria-label': 'Sections' },
    TABS.map(t =>
      h(
        'button',
        {
          class: `tab${t.tab === route.tab ? ' active' : ''}`,
          'aria-current': t.tab === route.tab ? 'page' : undefined,
          onclick: () => navigate({ tab: t.tab } as Route),
        },
        h('span', { class: 'tab-icon' }, icon(t.icon)),
        t.label,
      ),
    ),
  )

  root?.replaceChildren(
    header,
    ...(banner ? [banner] : []),
    content,
    ...(current.footer ? [current.footer] : []),
    tabbar,
  )

  const el = content
  if (refresh && !(current.scrollToEnd && nearEnd)) el.scrollTop = scrollTop
  else if (current.scrollToEnd) requestAnimationFrame(() => (el.scrollTop = el.scrollHeight))
  else el.scrollTop = 0
}

// The glasses follow this app's moves when they are connected and the
// place has a glasses version (see app.ts's routeToScreen).
function steerGlasses(next: Route): void {
  if (!connected) return
  const screen = routeToScreen(next)
  if (!screen) return
  const key = screenKey(screen)
  if (key === screenKey(getCurrentScreen())) return
  expectedKey = key
  requestScreen(screen)
}

function navigate(next: Route): void {
  route = next
  follow = null
  render()
  steerGlasses(next)
}

const ctx: AppContext = {
  navigate,
  glassesConnected: () => connected,
  requestGlasses: screen => {
    if (!connected) return
    expectedKey = screenKey(screen)
    requestScreen(screen)
  },
  refresh: () => render(true),
}

onCurrentScreenChange(screen => {
  const key = screenKey(screen)
  if (key === glassesKey) return
  glassesKey = key
  if (key === expectedKey) {
    expectedKey = null
    render(true)
    return
  }
  const target = screenToRoute(screen)
  if (!target || sameRoute(target, route)) {
    render(true)
    return
  }
  if (isTyping()) {
    follow = target
    render(true)
    return
  }
  route = target
  follow = null
  render()
})

// Connection: only "disconnected" and "failed" count as off - before the
// first status arrives, or in the simulator, the glasses are assumed there.
function applyConnection(status: { connectType?: string } | null | undefined): void {
  const type = status?.connectType
  const now = !(type === 'disconnected' || type === 'connectionFailed')
  if (now === connected) return
  connected = now
  render(true)
}

void bridge
  .getDeviceInfo()
  .then(info => applyConnection(info?.status))
  .catch(() => {})
bridge.onDeviceStatusChanged(status => applyConnection(status))

// Opens wherever the glasses already are, if that has a page here.
const start = getCurrentScreen()
glassesKey = screenKey(start)
route = screenToRoute(start) ?? { tab: 'jarvis' }
render()

// Dev server only: the remote control in vite.config.ts and devControl.ts.
// import.meta.hot does not exist in a build, so neither does this.
if (import.meta.hot) {
  const hot = import.meta.hot
  void import('./devControl').then(({ runDevCommand }) => {
    hot.on('companion:dev', command => runDevCommand(command, navigate))
  })
}
