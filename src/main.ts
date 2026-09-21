import {
  waitForEvenAppBridge,
  TextContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
  AppLocationAccuracy,
  type AppLocation,
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

// Hardcoded per the G2-3 out-of-scope list ("Loading the script from anywhere").
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

// Persisted scroll position. Survives app restarts, not just navigation —
// the app process can be reclaimed by the OS without the wearer accepting
// the exit dialog, so in-memory state is not sufficient. Dotted namespace
// so future per-tool keys stay grouped: 'teleprompter.line', 'weather.last'.
const STORAGE_KEY_TELEPROMPTER = 'teleprompter.line'

// Current starting line. Assigned from storage at startup; updated on every
// successful scroll. No longer reset on open — the whole point of the ticket
// is that reopening resumes where the wearer left off.
let teleprompterLine = 0

function scriptSlice(startLine: number): string {
  return SCRIPT.slice(startLine, startLine + LINES_PER_VIEW).join('\n')
}

// Read the persisted line number and clamp it to the current script.
//
// Any failure resolves to 0: starting at the top is the safe default, and
// every plausible representation of "no stored value" — empty string, the
// literal 'null', 'undefined' — parses to NaN, which the finite check
// catches. We do not need to know which one the host returns.
async function readStoredLine(): Promise<number> {
  try {
    const raw = await bridge.getLocalStorage(STORAGE_KEY_TELEPROMPTER)
    const parsed = parseInt(raw, 10)
    if (!Number.isFinite(parsed) || parsed < 0) return 0
    return Math.min(parsed, TELEPROMPTER_MAX_START)
  } catch {
    return 0
  }
}

// Move the viewport by one line and redraw in place. Bounds-checked before any
// state change; teleprompterLine is only committed when the upgrade resolves
// true, so a failure leaves the line number matching what is on screen rather
// than one ahead.
//
// The write to storage is fired after the in-memory commit and does not block
// further input. Fast scrolling may queue writes that race at the host. This
// assumes the SDK delivers messages in order, so the last write wins — that is
// an assumption, not something verified, and the project has been burned
// before by treating a plausible guarantee as a known one. If it proves
// untrue, the fix is a write queue, not a redesign.
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
        bridge
          .setLocalStorage(STORAGE_KEY_TELEPROMPTER, String(target))
          .then(stored => {
            if (!stored) status('Failed to persist position')
          })
      } else {
        status('Scroll failed')
      }
    })
}

// --- GPS state ------------------------------------------------------------
//
// The first tool that asks the platform for something. Three concerns the
// teleprompter never had:
//
//   • A declared permission in app.json. The host prompts on first use, and
//     the wearer can refuse. We cannot observe refusal directly.
//   • Data arriving after the page is already on screen. The page renders
//     "Acquiring location..." immediately, before any fix exists.
//   • A resource that runs until stopped. startAppLocationUpdates keeps the
//     host polling; stopAppLocationUpdates stops the host side, and the
//     unsubscribe returned by onAppLocationChanged only stops US receiving.
//     Both are needed. A subscription that outlives the page is invisible —
//     no error, no task manager, just battery drain the wearer notices weeks
//     later. We call stopGps() on every path we control.
//
// Continuous rather than one-shot because the ticket's criteria are shaped
// around a subscription that must be stopped ("Leaving the GPS page stops any
// location subscription it started"). One-shot has no subscription, which
// would dissolve the ticket's actual question.
//
// Accuracy is Low on purpose. This is a launcher on a face-worn device, not
// navigation, and high accuracy runs the receiver hotter for precision nobody
// asked for. The wearer wants "roughly where I am."
//
// "Permission denied" and "no fix available" collapse to the same message:
// startAppLocationUpdates resolving false, timing out, and never calling back
// are all indistinguishable from here. The display says "Location unavailable"
// and deliberately NOT "Permission denied" — asserting a cause we cannot
// observe is worse than saying less. Telling someone to check permissions when
// the real problem is a weak fix is actively misleading.
const GPS_INDEX = TOOLS.indexOf('GPS')
const GPS_ACCURACY = AppLocationAccuracy.Low
const GPS_TIMEOUT_MS = 10_000
const GPS_ACQUIRING_TEXT = 'Acquiring location...'
const GPS_UNAVAILABLE_TEXT = 'Location unavailable'

// Runtime GPS state. All of this resets on every open. gpsActive is the guard
// every async callback checks before acting — a late resolution after the
// wearer has left must not touch the page or the subscription.
let gpsActive = false
let gpsUnsubscribe: (() => void) | null = null
let gpsTimeoutId: ReturnType<typeof setTimeout> | null = null

function formatLocation(loc: AppLocation): string {
  return `Lat: ${loc.latitude.toFixed(4)}\nLon: ${loc.longitude.toFixed(4)}`
}

// Update the GPS page text to show a fix. Uses textContainerUpgrade, not
// rebuild — the layout does not change, only the words.
function showGpsLocation(loc: AppLocation) {
  status(`Location: ${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}`)
  bridge
    .textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: 1,
        containerName: 'tool',
        content: formatLocation(loc),
      }),
    )
    .then(ok => {
      if (!ok) status('GPS display update failed')
    })
}

// Show "Location unavailable". Called when the host refuses, or when no fix
// arrives within GPS_TIMEOUT_MS.
function showGpsUnavailable() {
  status('Location unavailable')
  bridge
    .textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: 1,
        containerName: 'tool',
        content: GPS_UNAVAILABLE_TEXT,
      }),
    )
    .then(ok => {
      if (!ok) status('Failed to show unavailable state')
    })
}

// Begin streaming location. Called only after the GPS page has been rebuilt —
// the textContainerUpgrade calls below target the 'tool' container by ID and
// name, so the container has to exist on screen first.
function startGps() {
  gpsActive = true

  // Timeout starts now, not after startAppLocationUpdates resolves. Worst
  // case is GPS_TIMEOUT_MS from page open regardless of how slow the host
  // is to acknowledge — bounded, not "whenever."
  // The timeout shows "unavailable" but deliberately does NOT call stopGps().
  // The subscription stays live so a late fix still lands and the page
  // self-heals — a fix at second 14 is better than none. Adding stopGps()
  // here reads like tidying missed cleanup, passes every test in the PR, and
  // silently removes that recovery. Leave the subscription running.
  gpsTimeoutId = setTimeout(() => {
    gpsTimeoutId = null
    if (!gpsActive) return
    showGpsUnavailable()
  }, GPS_TIMEOUT_MS)

  // Subscribe BEFORE starting updates, so a fast first fix doesn't arrive
  // before we have a callback to receive it.
  gpsUnsubscribe = bridge.onAppLocationChanged(loc => {
    if (!gpsActive) return
    if (gpsTimeoutId !== null) {
      clearTimeout(gpsTimeoutId)
      gpsTimeoutId = null
    }
    showGpsLocation(loc)
  })

  bridge
    .startAppLocationUpdates({ accuracy: GPS_ACCURACY })
    .then(ok => {
      if (!gpsActive) return
      if (!ok) {
        // Host refused — permission denied or platform error. From here they
        // look identical, so we say the vaguer thing.
        showGpsUnavailable()
        stopGps()
      }
    })
}

// Stop streaming location and clean up local state. Safe to call when GPS is
// not running — the gpsActive check makes it a no-op. Called from every exit
// path we control: leaving the GPS page by double-tap, and the OS-initiated
// exit events. Not called from a code path we do not reach, because we do not
// reach one — process reclamation can tear the WebView down before any event
// arrives, and the stop call in that case is impossible. That is the honest
// limit, not a gap in the code.
function stopGps() {
  if (!gpsActive) return
  gpsActive = false

  if (gpsTimeoutId !== null) {
    clearTimeout(gpsTimeoutId)
    gpsTimeoutId = null
  }

  if (gpsUnsubscribe !== null) {
    gpsUnsubscribe()
    gpsUnsubscribe = null
  }

  bridge.stopAppLocationUpdates().then(ok => {
    if (!ok) status('Failed to stop location updates')
  })
}

// Request the system exit confirmation dialog.
//
// Mode 1, not 0: the QA guidelines require the confirmation dialog on the root
// page, and explicitly reject both silent exit (mode 0) and a custom in-app
// confirm. This is the single QA-graded behaviour in G2-5.
//
// shutDownPageContainer returns Promise<boolean>. A false result means the
// wearer double-tapped and got nothing, which is exactly the rejection scenario
// the root double-tap exists to prevent. Surface it.
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

// What a tool page shows when it first opens. The teleprompter shows the
// script from its persisted position; GPS shows the acquiring message and
// then gets upgraded in place when a fix arrives; the other three show their
// name, unchanged from G2-2.
function toolInitialContent(index: number): string {
  if (index === TELEPROMPTER_INDEX) return scriptSlice(teleprompterLine)
  if (index === GPS_INDEX) return GPS_ACQUIRING_TEXT
  return TOOLS[index]
}

// One full-canvas text container, and it MUST set isEventCapture: 1 — a page
// with no capture container has no way out, and it is also the container that
// receives the scroll events the teleprompter depends on and the container
// the GPS upgrades target.
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
        content: toolInitialContent(index),
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

// Kick off the storage read before page creation. The startup page is the
// menu, which does not render teleprompter content, so page construction does
// not depend on the stored line. The read resolves in parallel and is awaited
// before the event handler is registered — by then the wearer cannot yet have
// navigated anywhere, so there is no in-flight state to render around.
//
// Same hazard as waitForEvenAppBridge above: a hung host and a crashed host
// look identical from here. readStoredLine's try/catch handles rejection, but
// a promise that never settles is not a rejection — it hangs forever, and the
// await below would block event handler registration. The menu has already
// rendered by then, so the wearer would see a healthy app that responds to
// nothing. Race against a timeout that resolves to 0 (top of script, the safe
// default), so the read either returns a value or gives up.
const storedLinePromise = Promise.race([
  readStoredLine(),
  new Promise<number>(resolve => {
    setTimeout(() => resolve(0), 10000)
  }),
])

const result = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer(menuContainers()),
)

status(
  result === 0
    ? 'Page created: success. Check the glasses display.'
    : `Page created: FAILED with code ${result} (1 invalid, 2 oversize, 3 out of memory)`,
)

teleprompterLine = await storedLinePromise

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
//      Must be first so nothing below can swallow it. Also the point where
//      GPS stops streaming if the page being left is GPS.
//   2. listEvent click while on the menu → open the highlighted tool. If the
//      tool is GPS, start streaming AFTER the page is up.
//   3. Scroll on the teleprompter page → advance/retreat one line.
//   4. Exit events → stop GPS, unsubscribe.
//
// Tap on a tool page does nothing under the current model. No branch handles
// it, which is correct — the tap is free for whichever tool wants it later.
const unsubscribe = bridge.onEvenHubEvent(event => {
  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)
  const listType = eventTypeOf(event.listEvent)

  // Double-tap is context-sensitive:
  //   • On the menu (root), raise the system exit confirmation dialog.
  //   • On a tool page, return to the menu.
  //
  // This branch MUST stay first. If anything below it could swallow a
  // double-tap, the wearer might not be able to leave.
  //
  // Fail toward exit: if screen says tool but the rebuild to menu fails,
  // exit anyway. A wearer who gets an unexpected exit dialog can cancel.
  // A wearer who gets nothing cannot escape.
  const isDoubleTap =
    sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    textType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    listType === OsEventTypeList.DOUBLE_CLICK_EVENT

  if (isDoubleTap) {
    if (screen.kind === 'tool') {
      // Leaving a tool. If GPS was the page, stop streaming BEFORE the
      // rebuild — a location arriving mid-transition would otherwise
      // upgrade a container that is about to be replaced. stopGps() is
      // a no-op when GPS was not running.
      stopGps()
      bridge
        .rebuildPageContainer(new RebuildPageContainer(menuContainers()))
        .then(ok => {
          if (ok) {
            screen = { kind: 'menu' }
            status('Menu')
          } else {
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
  //
  // No reset of teleprompterLine here anymore: position is loaded once at
  // startup and updated on every scroll, so it is already correct when the
  // wearer opens the tool.
  const listEvent = event.listEvent
  if (listEvent && listType === OsEventTypeList.CLICK_EVENT && screen.kind === 'menu') {
    const index = listEvent.currentSelectItemIndex ?? 0
    if (index >= 0 && index < TOOLS.length) {
      bridge
        .rebuildPageContainer(new RebuildPageContainer(toolContainers(index)))
        .then(ok => {
          if (ok) {
            screen = { kind: 'tool', index }
            status(`Tool: ${TOOLS[index]}`)
            // Start GPS streaming only after the page is on screen. The
            // upgrade calls inside startGps target the 'tool' container by
            // ID and name — it has to exist first.
            if (index === GPS_INDEX) startGps()
          } else {
            status(`Failed to open ${TOOLS[index]}`)
          }
        })
    }
    return
  }

  // Scroll handling on the teleprompter page. SCROLL_TOP_EVENT and
  // SCROLL_BOTTOM_EVENT are 1 and 2, both non-zero, so the zero-elision trap
  // does not apply here.
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

  // OS-initiated exit. Best-effort: the WebView may be torn down before the
  // event reaches us, so stopGps() here is not guaranteed to run. If it does,
  // it saves the host from continuing to stream after we are gone. If it
  // doesn't, the host owns cleanup on its side.
  if (
    sysType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
    sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT
  ) {
    stopGps()
    unsubscribe()
  }
})
