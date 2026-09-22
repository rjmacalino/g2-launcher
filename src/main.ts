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
// index 0 (Weather) is falsy, so an `if (currentToolIndex)` check would treat
// "Weather is open" as "no tool is open". `screen.kind` has no such trap.
type Screen = { kind: 'menu' } | { kind: 'tool'; index: number }
let screen: Screen = { kind: 'menu' }

// --- Storage keys ---------------------------------------------------------
//
// Dotted namespace so future per-tool keys stay grouped: 'teleprompter.line',
// 'ui.screen', 'weather.last'.
const STORAGE_KEY_TELEPROMPTER = 'teleprompter.line'
const STORAGE_KEY_SCREEN = 'ui.screen'

// How recently the screen must have changed for a cold start to restore it.
// Long enough to cover a lock-screen resume (the Beta criterion locks the
// phone for 5 minutes), short enough that a deliberate relaunch the next
// morning lands on the menu.
const RESTORE_WINDOW_MS = 30 * 60 * 1000

// Ceiling on how long we wait for a storage read before giving up and using
// the fallback. Storage reads resolve in milliseconds; a hang means the host
// is not answering, and the fallback (menu, line 0) is always correct.
const STORAGE_READ_TIMEOUT_MS = 5000

// Same ceiling for the restore rebuild. Anything awaited between page creation
// and event handler registration can strand the wearer if it never settles:
// the menu is already drawn, so the glasses show a healthy app that listens to
// nothing, and root double-tap does nothing, which is the documented rejection
// trigger. Every host call on that stretch gets a timeout for that reason.
const RESTORE_REBUILD_TIMEOUT_MS = 5000

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
// with the event handler; it is the only place the wearer is told how to
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
// one display row, so longer lines wrap and silently cost a row, and a script
// with wrapped lines will show fewer than six entries per view. Fine for the
// current short-line script; worth revisiting when the script becomes
// user-supplied.
const LINES_PER_VIEW = 6

// Highest valid starting line. If the script is shorter than one view, this
// clamps to 0 so scrolling never advances past the only page.
const TELEPROMPTER_MAX_START = Math.max(0, SCRIPT.length - LINES_PER_VIEW)

// Current starting line. Assigned from storage at startup; updated on every
// successful scroll. No longer reset on open; the whole point of G2-7 is that
// reopening resumes where the wearer left off.
let teleprompterLine = 0

function scriptSlice(startLine: number): string {
  return SCRIPT.slice(startLine, startLine + LINES_PER_VIEW).join('\n')
}

// Read the persisted line number and clamp it to the current script.
//
// Any failure resolves to 0: starting at the top is the safe default, and
// every plausible representation of "no stored value" (empty string, the
// literal 'null', 'undefined') parses to NaN, which the finite check catches.
// We do not need to know which one the host returns.
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
// assumes the SDK delivers messages in order, so the last write wins. That is
// an assumption, not something verified, and the project has been burned
// before by treating a plausible guarantee as a known one.
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

// --- Screen persistence ---------------------------------------------------
//
// `screen` is in-memory. On Android, the WebView can be suspended under memory
// pressure and the module re-runs on resume, so in-memory state is lost. We
// persist the current screen eagerly and restore it on startup if it is recent
// enough to be a resume rather than a fresh launch.
//
// The timestamp answers "how long ago was the wearer last on this page?" A
// cold start picks the value up and compares against RESTORE_WINDOW_MS. Below
// the window, restore. Above it, start on the menu as usual.
function persistScreen(s: Screen) {
  const payload = JSON.stringify({
    kind: s.kind,
    index: s.kind === 'tool' ? s.index : null,
    at: Date.now(),
  })
  bridge.setLocalStorage(STORAGE_KEY_SCREEN, payload).then(ok => {
    if (!ok) status('Failed to persist screen')
  })
}

// Parse the persisted screen. Returns null on any failure or if the value is
// stale by RESTORE_WINDOW_MS. The caller falls back to the menu.
async function readStoredScreen(): Promise<Screen | null> {
  try {
    const raw = await bridge.getLocalStorage(STORAGE_KEY_SCREEN)
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.at !== 'number') return null
    if (Date.now() - parsed.at > RESTORE_WINDOW_MS) return null
    if (parsed.kind === 'menu') return { kind: 'menu' }
    if (parsed.kind === 'tool') {
      const i = parsed.index
      if (typeof i !== 'number' || i < 0 || i >= TOOLS.length) return null
      return { kind: 'tool', index: i }
    }
    return null
  } catch {
    return null
  }
}

// --- GPS state ------------------------------------------------------------
//
// The first tool that asks the platform for something. Three concerns the
// teleprompter never had:
//
//   - A declared permission in app.json. The host prompts on first use, and
//     the wearer can refuse. We cannot observe refusal directly.
//   - Data arriving after the page is already on screen. The page renders
//     "Acquiring location..." immediately, before any fix exists.
//   - A resource that runs until stopped. stopAppLocationUpdates stops the
//     HOST sending; the unsubscribe returned by onAppLocationChanged only
//     stops US receiving. Both are needed. Dropping either one looks clean
//     from the side you kept, which is why a leak here is invisible: no
//     error, no task manager, just battery the wearer notices weeks later.
//     We call stopGps() on every exit path we control, and re-arm on every
//     foreground-enter if the GPS page is showing, because the OS stops the
//     subscription for us when the WebView is suspended.
//
// Continuous rather than one-shot. A one-shot read has no subscription to
// stop, which would make the lifecycle question disappear rather than answer
// it, and the GPS page is meant to keep up with a wearer who is moving.
//
// Accuracy is Low on purpose. This is a launcher on a face-worn device, not
// navigation, and high accuracy runs the receiver hotter for precision nobody
// asked for. The wearer wants "roughly where I am."
//
// "Permission denied" and "no fix available" collapse to the same message.
// startAppLocationUpdates resolving false, timing out, and never calling back
// are all indistinguishable from here. The display says "Location unavailable"
// and deliberately NOT "Permission denied", because asserting a cause we
// cannot observe is worse than saying less.
const GPS_INDEX = TOOLS.indexOf('GPS')
const GPS_ACCURACY = AppLocationAccuracy.Low
const GPS_TIMEOUT_MS = 10_000
const GPS_ACQUIRING_TEXT = 'Acquiring location...'
const GPS_UNAVAILABLE_TEXT = 'Location unavailable'

// Runtime GPS state. All of this resets on every open. gpsActive is the guard
// every async callback checks before acting, so a late resolution after the
// wearer has left cannot touch the page or the subscription.
let gpsActive = false
let gpsUnsubscribe: (() => void) | null = null
let gpsTimeoutId: ReturnType<typeof setTimeout> | null = null

function formatLocation(loc: AppLocation): string {
  return `Lat: ${loc.latitude.toFixed(4)}\nLon: ${loc.longitude.toFixed(4)}`
}

// Update the GPS page text to show a fix. Uses textContainerUpgrade, not
// rebuild, because the layout does not change, only the words.
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

// Begin streaming location. Called only after the GPS page is on screen,
// because the textContainerUpgrade calls below target the 'tool' container by
// ID and name, so the container has to exist first.
function startGps() {
  gpsActive = true

  // The timeout shows "unavailable" but deliberately does NOT call stopGps().
  // The subscription stays live so a late fix still lands and the page
  // self-heals. A fix at second 14 is better than none. Adding stopGps() here
  // reads like tidying up missed cleanup, passes every test we have, and
  // silently removes that recovery. Leave the subscription running.
  //
  // The timer starts now, not after startAppLocationUpdates resolves. Worst
  // case is GPS_TIMEOUT_MS from page open regardless of how slow the host is
  // to acknowledge, which is bounded rather than "whenever."
  gpsTimeoutId = setTimeout(() => {
    gpsTimeoutId = null
    if (!gpsActive) return
    showGpsUnavailable()
  }, GPS_TIMEOUT_MS)

  // Subscribe BEFORE starting updates, so a fast first fix does not arrive
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
        // Host refused, or platform error. From here they look identical, so
        // we say the vaguer thing.
        showGpsUnavailable()
        stopGps()
      }
    })
}

// Stop streaming location and clean up local state. Returns a promise that
// resolves when the host has acknowledged the stop, so callers that want to
// re-arm immediately (rearmGps) can sequence correctly. Callers that just
// want cleanup (double-tap, OS exit, foreground-exit) can ignore the promise.
function stopGps(): Promise<void> {
  if (!gpsActive) return Promise.resolve()
  gpsActive = false

  if (gpsTimeoutId !== null) {
    clearTimeout(gpsTimeoutId)
    gpsTimeoutId = null
  }

  if (gpsUnsubscribe !== null) {
    gpsUnsubscribe()
    gpsUnsubscribe = null
  }

  return bridge.stopAppLocationUpdates().then(ok => {
    if (!ok) status('Failed to stop location updates')
  })
}

// Bring GPS back after a foreground return. The subscription may or may not
// still be live depending on the platform and whether the WebView was
// suspended; tearing down first guarantees a clean re-arm either way. On iOS
// the subscription survives backgrounding, so this is a stop-start that
// costs a fraction of a second. On Android the subscription is likely already
// dead, so this is the path that actually restarts it.
//
// The display is reset to "Acquiring location..." before re-arming. Showing
// the last fix as though it were live is the failure mode this exists to
// prevent: a stale coordinate is indistinguishable from a fresh one at four
// decimal places.
function rearmGps() {
  stopGps().then(() => {
    bridge
      .textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: 1,
          containerName: 'tool',
          content: GPS_ACQUIRING_TEXT,
        }),
      )
      .then(() => {
        // Only start if we are still on the GPS page. If the wearer navigated
        // away during the async stop, do not restart a subscription they did
        // not ask for.
        if (screen.kind === 'tool' && screen.index === GPS_INDEX) {
          startGps()
        }
      })
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

// One full-canvas text container, and it MUST set isEventCapture: 1. A page
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

// --- Startup --------------------------------------------------------------
//
// Both reads race a timeout, so a hung host cannot block startup. A cold start
// after Android suspend re-runs this module from scratch, so whatever we do
// here also defines the cold-start experience.
const storedScreenPromise = Promise.race([
  readStoredScreen(),
  new Promise<Screen | null>(resolve => {
    setTimeout(() => resolve(null), STORAGE_READ_TIMEOUT_MS)
  }),
])
const storedLinePromise = Promise.race([
  readStoredLine(),
  new Promise<number>(resolve => {
    setTimeout(() => resolve(0), STORAGE_READ_TIMEOUT_MS)
  }),
])

// Show the menu first. It is the safe default and every path that does not
// restore lands here anyway. Creating it before the reads resolve means the
// first frame is never blocked on storage.
const result = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer(menuContainers()),
)

// Page creation result.
//
// Hardware is the source of truth here. On real glasses this succeeds, which
// proves the payload is valid. In the simulator and a plain browser, code 1
// appears non-deterministically: sometimes on first load, sometimes on
// refresh, sometimes not at all. See README "Page creation in the simulator
// and browser" and issue #11.
//
// Deliberately no retry. Adding one would touch the path that works on
// hardware in order to quiet an environment where failure is expected.
if (result === 0) {
  status('Page created: success. Check the glasses display.')
} else {
  status(
    `Page creation returned code ${result} (1 invalid, 2 oversize, 3 out of memory). ` +
      `On hardware this is a real problem. In the simulator and plain browser, ` +
      `code 1 is expected and does not indicate a problem with the app.`,
  )
}

// Await persisted state.
const [restoredScreen, restoredLine] = await Promise.all([
  storedScreenPromise,
  storedLinePromise,
])

teleprompterLine = restoredLine

// If a recent tool page was stored, rebuild to it. The menu was already shown;
// the rebuild causes a brief flicker during cold start, which is the trade for
// never blocking the first frame on a storage read.
if (restoredScreen && restoredScreen.kind === 'tool') {
  const ok = await Promise.race([
    bridge.rebuildPageContainer(
      new RebuildPageContainer(toolContainers(restoredScreen.index)),
    ),
    new Promise<boolean>(resolve => {
      setTimeout(() => resolve(false), RESTORE_REBUILD_TIMEOUT_MS)
    }),
  ])
  if (ok) {
    screen = restoredScreen
    status(`Restored: ${TOOLS[restoredScreen.index]}`)
    if (restoredScreen.index === GPS_INDEX) startGps()
  } else {
    status(`Failed to restore ${TOOLS[restoredScreen.index]}`)
  }
}

// Refresh the persisted screen's timestamp. If we restored to a tool, this
// carries the new "current"; if we stayed on the menu, it stamps menu as
// current so a subsequent quick suspend-resume correctly lands here. Without
// this, a string of quick resumes would expire after the original window
// elapsed, even though the wearer never left the app for long.
persistScreen(screen)

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
//   - sysEvent  -> taps, double-taps, lifecycle (foreground, exit)
//   - textEvent -> scroll gestures and clicks on text containers
//   - listEvent -> list item events (highlight, click)
//
//   1. Double-tap -> context-sensitive: exit on the menu, back on a tool page.
//      Must be first so nothing below can swallow it. Also the point where GPS
//      stops streaming if the page being left is GPS.
//   2. Foreground enter -> re-arm GPS if the GPS page is showing. The
//      subscription may or may not have survived; rearmGps handles both.
//   3. Foreground exit -> tear down GPS. The OS may stop the subscription for
//      us, but stopping it explicitly means the next foreground enter re-arms
//      against a known-clean slate.
//   4. listEvent click while on the menu -> open the highlighted tool.
//   5. Scroll on the teleprompter page -> advance/retreat one line.
//   6. Exit events -> stop GPS, unsubscribe.
//
// Tap on a tool page does nothing under the current model. No branch handles
// it, which is correct. The tap is free for whichever tool wants it later.
const unsubscribe = bridge.onEvenHubEvent(event => {
  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)
  const listType = eventTypeOf(event.listEvent)

  // Double-tap is context-sensitive:
  //   - On the menu (root), raise the system exit confirmation dialog.
  //   - On a tool page, return to the menu.
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
      // Stop streaming BEFORE the rebuild, so a location arriving
      // mid-transition cannot upgrade a container that is about to be
      // replaced. stopGps() is a no-op when GPS was not the page.
      stopGps()
      bridge
        .rebuildPageContainer(new RebuildPageContainer(menuContainers()))
        .then(ok => {
          if (ok) {
            screen = { kind: 'menu' }
            persistScreen(screen)
            status('Menu')
          } else {
            requestExit()
          }
        })
    } else {
      // Menu, or any state we do not recognise. This is deliberately not
      // `screen.kind === 'menu'`: anything that is not a confirmed tool page
      // falls through to exit, so a screen variant added later defaults to
      // escapable rather than stranded. That is the guarantee the branch used
      // to get for free by being unconditional.
      requestExit()
    }
    return
  }

  // Foreground return. If GPS was showing when we went away, the subscription
  // may have stopped (Android suspend) or may still be live (iOS). rearmGps
  // tears down first, which works for both, and resets the visible fix so a
  // stale coordinate cannot masquerade as a current one.
  if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    if (screen.kind === 'tool' && screen.index === GPS_INDEX) {
      rearmGps()
    }
    return
  }

  // Going to background. Tear down the GPS subscription so we do not leak one
  // if the OS does not kill the WebView, and so the next foreground enter
  // re-arms against a known-clean slate.
  if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
    stopGps()
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
      bridge
        .rebuildPageContainer(new RebuildPageContainer(toolContainers(index)))
        .then(ok => {
          if (ok) {
            screen = { kind: 'tool', index }
            persistScreen(screen)
            status(`Tool: ${TOOLS[index]}`)
            // Start GPS streaming only after the page is on screen. The
            // upgrade calls inside startGps target the 'tool' container by
            // ID and name, so it has to exist first.
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
  // it saves the host from continuing to stream after we are gone.
  if (
    sysType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
    sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT
  ) {
    stopGps()
    unsubscribe()
  }
})
