import {
  waitForEvenAppBridge,
  TextContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  OsEventTypeList,
} from '@evenrealities/even_hub_sdk'

// The companion page is the only surface that can show startup problems, since a
// failure here means nothing ever reaches the glasses.
const statusEl = document.getElementById('app')

function status(line: string) {
  console.log(line)
  if (statusEl) statusEl.textContent = line
}

window.addEventListener('unhandledrejection', event => {
  status(`Startup failed: ${event.reason}`)
})
window.addEventListener('error', event => {
  status(`Error: ${event.message}`)
})

status('Waiting for the Even app bridge...')

// A hung bridge and a crashed bridge look identical on the glasses (blank screen,
// no event container), so force the hang to announce itself.
const bridge = await Promise.race([
  waitForEvenAppBridge(),
  new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error('bridge did not arrive within 10s')), 10000)
  }),
])

status('Bridge ready, creating page...')

// Source of truth for both the menu labels and which page an index refers to.
// Order matters: index 0 is Weather, and that index is what the firmware reports
// back as currentSelectItemIndex on a click.
const TOOLS = ['Weather', 'GPS', 'Notes', 'Teleprompter'] as const

// Which page is showing. A discriminated union, not `number | null`, because
// index 0 (Weather) is falsy — an `if (currentToolIndex)` check would treat
// "Weather is open" as "no tool is open". `screen.kind` has no such trap. The
// union also lets TypeScript narrow the index when we branch on `kind === 'tool'`.
//
// Not persisted, per the ticket's out-of-scope list — a launcher starts on the
// menu every launch.
type Screen = { kind: 'menu' } | { kind: 'tool'; index: number }
let screen: Screen = { kind: 'menu' }

// Container data for the menu page. Reused by both the initial page creation
// (CreateStartUpPageContainer) and every return-to-menu (RebuildPageContainer).
const titleText = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 48,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: 4,
  containerID: 1,
  containerName: 'title',
  content: 'Launcher',
  isEventCapture: 0,
})

const menuList = new ListContainerProperty({
  xPosition: 0,
  yPosition: 48,
  width: 576,
  height: 240,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: 4,
  containerID: 2,
  containerName: 'menu',
  isEventCapture: 1,
  itemContainer: new ListItemContainerProperty({
    itemCount: TOOLS.length,
    itemWidth: 576,
    isItemSelectBorderEn: 1,
    itemName: [...TOOLS],
  }),
})

// Container data for a tool page. One full-canvas text container, and it MUST
// set isEventCapture: 1 — a page with no capture container has no way out.
function toolContainers(index: number) {
  return {
    containerTotalNum: 1,
    textObject: [
      new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 288,
        borderWidth: 0,
        borderColor: 5,
        paddingLength: 4,
        containerID: 1,
        containerName: 'tool',
        content: TOOLS[index],
        isEventCapture: 1,
      }),
    ],
  }
}

function menuContainers() {
  return {
    containerTotalNum: 2,
    textObject: [titleText],
    listObject: [menuList],
  }
}

// Initial page. Same container data the menu rebuild will use, so the menu
// after a return is byte-identical to the menu on launch.
const result = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer(menuContainers()),
)

status(
  result === 0
    ? 'Page created: success. Check the glasses display.'
    : `Page created: FAILED with code ${result} (1 invalid, 2 oversize, 3 out of memory)`,
)

// Reads the event type out of one envelope.
//
// CLICK_EVENT is 0, and protobuf omits zero-value fields on the wire, so a
// single tap arrives as an envelope whose `eventType` is `undefined`. The
// default has to be resolved INSIDE the envelope check. Writing
// `event.sysEvent?.eventType ?? OsEventTypeList.CLICK_EVENT` instead would
// read CLICK on events that carry no `sysEvent` at all, so every scroll,
// exit and audio frame would fire the tap handler.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

// Event routing. Three envelopes, and the order below is load-bearing:
//
//   • sysEvent  → taps, double-taps, lifecycle
//   • textEvent → scroll gestures on text containers
//   • listEvent → list item events (highlight, click). THIS is the envelope
//                 the launcher menu's taps arrive on.
//
//   1. Double-tap → shutDownPageContainer(1) MUST be first. It is the only
//      universal exit, and it must fire from any page in any state. If a
//      later branch could swallow the event, the wearer is stuck.
//   2. List click while on the menu → open the tool at currentSelectItemIndex.
//   3. Any click while on a tool page → return to the menu.
//   4. Exit events → unsubscribe.
const unsubscribe = bridge.onEvenHubEvent(event => {
  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)
  const listType = eventTypeOf(event.listEvent)

  if (
    sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    textType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    listType === OsEventTypeList.DOUBLE_CLICK_EVENT
  ) {
    bridge.shutDownPageContainer(1)
    return
  }

  // currentSelectItemIndex is 0 for the first item (Weather), and protobuf
  // elides zero values, so tapping Weather can arrive as `undefined`. Resolve
  // the default INSIDE the branch where we already know listEvent exists and
  // the event is a click — same shape as eventTypeOf above, one level deeper.
  const listEvent = event.listEvent
  if (listEvent && listType === OsEventTypeList.CLICK_EVENT && screen.kind === 'menu') {
    const index = listEvent.currentSelectItemIndex ?? 0
    if (index >= 0 && index < TOOLS.length) {
      screen = { kind: 'tool', index }
      void bridge.rebuildPageContainer(new RebuildPageContainer(toolContainers(index)))
      status(`Tool: ${TOOLS[index]}`)
    }
    return
  }

  // Tool pages have no list, so the tap arrives on sysEvent (or textEvent).
  // Only fires when a tool page is showing — the menu's list clicks were
  // handled above and returned early.
  if (
    screen.kind === 'tool' &&
    (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT)
  ) {
    screen = { kind: 'menu' }
    void bridge.rebuildPageContainer(new RebuildPageContainer(menuContainers()))
    status('Menu')
    return
  }

  if (
    sysType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
    sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT
  ) {
    unsubscribe()
  }
})
