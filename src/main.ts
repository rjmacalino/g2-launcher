import {
  waitForEvenAppBridge,
  TextContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerUpgrade,
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
// "Weather is open" as "no tool is open". `screen.kind` has no such trap.
type Screen = { kind: 'menu' } | { kind: 'tool'; index: number }
let screen: Screen = { kind: 'menu' }

// --- Teleprompter state ---------------------------------------------------
//
// The smallest thing that distinguishes one real tool from three placeholders:
// a named constant and one guarded branch in the event handler. No registry,
// no dispatch table, no per-tool module. When Weather lands with behaviour it
// gets a sibling constant and a sibling branch; if those start to look alike,
// that is the signal to factor, not before.
const TELEPROMPTER_INDEX = TOOLS.indexOf('Teleprompter')

// Hardcoded per the ticket's out-of-scope list ("Loading the script from
// anywhere"). Kept short so lines don't wrap, and long enough that scrolling
// is meaningful.
//
// The last stanza describes the shipped gesture model. It has to stay in sync
// with the event handler — it is the only place the wearer is told how to
// leave this page.
const SCRIPT = [
  'Good morning everyone.',
  '',
  'Thank you for being here.',
  'This is the teleprompter.',
  '',
  'Scroll to advance.',
  'Scroll back to return.',
  '',
  'The text you are reading',
  'is delivered in place,',
  'not redrawn.',
  '',
  'That matters because',
  'a full redraw flickers,',
  'and a teleprompter',
  'that flickers is useless.',
  '',
  'Every line here',
  'arrives through a single',
  'in-place update.',
  '',
  'No page rebuild,',
  'no visible flash,',
  'just the words moving.',
  '',
  'When you reach the end,',
  'scrolling further',
  'does nothing.',
  '',
  'When you return to the top,',
  'scrolling further',
  'does nothing too.',
  '',
  'Double tap to return',
  'to the launcher menu.',
  '',
  'On the menu, double tap',
  'to exit the app.',
  '',
  'That is the whole demo.',
  'Thank you.',
]

// How many script lines fit on one screen. This assumes one script line maps to
// one display row — longer lines wrap and silently cost a row, so a script with
// wrapped lines will show fewer than six entries per view. Fine for the current
// short-line script; worth revisiting when the script becomes user-supplied.
const LINES_PER_VIEW = 6

// Highest valid starting line. If the script is shorter than one view, this
// clamps to 0 so scrolling never advances past the only page.
const TELEPROMPTER_MAX_START = Math.max(0, SCRIPT.length - LINES_PER_VIEW)

// Current starting line. Reset to 0 each time the teleprompter opens —
// persistence between openings is out of scope.
let teleprompterLine = 0

function scriptSlice(startLine: number): string {
  return SCRIPT.slice(startLine, startLine + LINES_PER_VIEW).join('\n')
}

// Move the viewport by one line and redraw in place. Bounds-checked before any
// state change; teleprompterLine is only committed when the upgrade resolves
// true, so a failure leaves the line number matching what is on screen rather
// than one ahead. Same principle as the deferred screen mutation in G2-2.
function tryScroll(delta: 1 | -1) {
  const target = teleprompterLine + delta
  if (target < 0 || target > TELEPROMPTER_MAX_START) return
  bridge
    .textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: 1,
        containerName: 'tool',
        content: scriptSlice(target),
      }),
    )
    .then(ok => {
      if (ok) {
        teleprompterLine = target
      } else {
        status('Scroll failed')
      }
    })
}

// Request the system exit confirmation dialog.
//
// Mode 1, not 0: the QA guidelines require the confirmation dialog on the root
// page, and explicitly reject both silent exit (mode 0) and a custom in-app
// confirm. This is the single QA-graded behaviour in this ticket.
//
// shutDownPageContainer returns Promise<boolean>. A false result means the
// wearer double-tapped and got nothing, which is exactly the rejection scenario
// the root double-tap exists to prevent. Surface it — a silent failure here is
// the one bug we cannot allow to hide.
function requestExit() {
  bridge.shutDownPageContainer(1).then(ok => {
    if (!ok) status('Exit request failed: shutDownPageContainer returned false')
  })
}

// --- Containers -----------------------------------------------------------

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

// One full-canvas text container, and it MUST set isEventCapture: 1 — a page
// with no capture container has no way out, and it is also the container that
// receives the scroll events the teleprompter depends on.
//
// The teleprompter gets the script slice instead of the tool name. Every other
// tool gets its name, unchanged from G2-2.
function toolContainers(index: number) {
  const isTeleprompter = index === TELEPROMPTER_INDEX
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
        content: isTeleprompter ? scriptSlice(teleprompterLine) : TOOLS[index],
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
// `event.sysEvent?.eventType ?? CLICK_EVENT` instead would read CLICK on
// events that carry no `sysEvent` at all, so every scroll, exit and audio
// frame would fire the tap handler.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

// Event routing. Three envelopes, and the order below is load-bearing:
//
//   • sysEvent  → taps, double-taps, lifecycle
//   • textEvent → scroll gestures AND clicks on text containers
//   • listEvent → list item events (highlight, click)
//
//   1. Double-tap → context-sensitive: exit on the menu, back on a tool page.
//      Must be first so nothing below can swallow it.
//   2. listEvent click while on the menu → open the highlighted tool.
//   3. Scroll on the teleprompter page → advance/retreat one line.
//   4. Exit events → unsubscribe.
//
// Tap on a tool page does nothing under the new model. No branch handles it,
// which is correct — the tap is free for whichever tool wants it later.
const unsubscribe = bridge.onEvenHubEvent(event => {
  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)
  const listType = eventTypeOf(event.listEvent)

  // Double-tap is context-sensitive:
  //   • On the menu (root), raise the system exit confirmation dialog.
  //     The QA guidelines require mode 1 here — mode 0 (silent exit) and a
  //     custom in-app confirm are both explicitly rejected on root.
  //   • On a tool page, return to the menu.
  //
  // This branch MUST stay first. If anything below it could swallow a
  // double-tap, the wearer might not be able to leave.
  //
  // Fail toward exit: if screen says tool but the rebuild to menu fails,
  // exit anyway. A wearer who gets an unexpected exit dialog can cancel.
  // A wearer who gets nothing cannot escape. Those costs are not comparable.
  const isDoubleTap =
    sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    textType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    listType === OsEventTypeList.DOUBLE_CLICK_EVENT

  if (isDoubleTap) {
    if (screen.kind === 'tool') {
      bridge
        .rebuildPageContainer(new RebuildPageContainer(menuContainers()))
        .then(ok => {
          if (ok) {
            screen = { kind: 'menu' }
            status('Menu')
          } else {
            // Back failed. Exit rather than leave the wearer stuck.
            requestExit()
          }
        })
    } else {
      // Menu, or any state we do not recognise. Treat as root for the exit
      // check — the safer failure direction if they ever diverge.
      requestExit()
    }
    return
  }

  // currentSelectItemIndex is 0 for the first item (Weather), and protobuf
  // elides zero values, so tapping Weather can arrive as `undefined`. Resolve
  // the default INSIDE the branch where we already know listEvent exists and
  // the event is a click.
  const listEvent = event.listEvent
  if (listEvent && listType === OsEventTypeList.CLICK_EVENT && screen.kind === 'menu') {
    const index = listEvent.currentSelectItemIndex ?? 0
    if (index >= 0 && index < TOOLS.length) {
      // Reset the teleprompter position before the rebuild, so toolContainers
      // renders the top of the script rather than wherever it was left.
      if (index === TELEPROMPTER_INDEX) teleprompterLine = 0
      bridge
        .rebuildPageContainer(new RebuildPageContainer(toolContainers(index)))
        .then(ok => {
          if (ok) {
            screen = { kind: 'tool', index }
            status(`Tool: ${TOOLS[index]}`)
          } else {
            status(`Failed to open ${TOOLS[index]}`)
          }
        })
    }
    return
  }

  // Scroll handling on the teleprompter page. SCROLL_TOP_EVENT and
  // SCROLL_BOTTOM_EVENT are 1 and 2, both non-zero, so the zero-elision trap
  // does not apply here — the values arrive intact.
  //
  // At either bound tryScroll returns early without doing anything: scrolling
  // past an end must not wrap, throw, or render empty.
  if (screen.kind === 'tool' && screen.index === TELEPROMPTER_INDEX) {
    if (textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      tryScroll(1)
      return
    }
    if (textType === OsEventTypeList.SCROLL_TOP_EVENT) {
      tryScroll(-1)
      return
    }
  }

  if (
    sysType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
    sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT
  ) {
    unsubscribe()
  }
})
