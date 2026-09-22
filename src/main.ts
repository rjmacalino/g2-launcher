import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
} from '@evenrealities/even_hub_sdk'
import { bridge, status } from './bridge'
import {
  CANVAS_WIDTH,
  CONTAINER_ID_CONTENT,
  CONTAINER_NAME_CONTENT,
  CONTENT_HEIGHT,
  CONTENT_Y,
  PADDING,
} from './page'
import { readWithTimeout } from './storage'
import { hydrate as hydrateStatusBar, startStatusBar, statusBarContainer, stopStatusBar } from './statusbar'
import { persistScreen, readStoredScreen, type Screen } from './screen'
import { TOOLS, TOOL_NAMES } from './tools'

// The shell. Owns which page is showing, builds pages, and routes input. It knows
// tools only through the Tool interface, so adding one is a new file plus an entry
// in the TOOLS array rather than a new branch in here.

let screen: Screen = { kind: 'menu' }

function activeTool() {
  return screen.kind === 'tool' ? TOOLS[screen.index] : null
}

// Ceiling on the restore rebuild. Anything awaited between page creation and
// event handler registration can strand the wearer if it never settles: the menu
// is already drawn, so the glasses show a healthy app that listens to nothing,
// and root double-tap does nothing, which is the documented rejection trigger.
const RESTORE_REBUILD_TIMEOUT_MS = 5000

// --- Pages ----------------------------------------------------------------
//
// Every page is the status bar plus exactly one content container. The bar is
// built by statusBarContainer() in both builders below, which is what makes a
// page without a bar impossible to construct.

// The menu's "Launcher" title is gone. The status bar occupies that strip now and
// earns it better: a wearer opening the launcher already knows what it is, and a
// clock is worth more than a label naming the screen they are looking at.
const menuList = new ListContainerProperty({
  xPosition: 0,
  yPosition: CONTENT_Y,
  width: CANVAS_WIDTH,
  height: CONTENT_HEIGHT,
  borderWidth: 0,
  paddingLength: PADDING,
  containerID: CONTAINER_ID_CONTENT,
  containerName: 'menu',
  isEventCapture: 1,
  itemContainer: new ListItemContainerProperty({
    itemCount: TOOLS.length,
    itemWidth: CANVAS_WIDTH,
    isItemSelectBorderEn: 1,
    itemName: [...TOOL_NAMES],
  }),
})

// The content container MUST set isEventCapture: 1. A page with no capture
// container has no way out, and it is also the container the firmware scrolls and
// the one every tool's setContent targets.
function toolContainers(index: number) {
  return {
    containerTotalNum: 2,
    textObject: [
      statusBarContainer(),
      new TextContainerProperty({
        xPosition: 0,
        yPosition: CONTENT_Y,
        width: CANVAS_WIDTH,
        height: CONTENT_HEIGHT,
        borderWidth: 0,
        paddingLength: PADDING,
        containerID: CONTAINER_ID_CONTENT,
        containerName: CONTAINER_NAME_CONTENT,
        content: TOOLS[index].initialContent(),
        isEventCapture: 1,
      }),
    ],
  }
}

function menuContainers() {
  return {
    containerTotalNum: 2,
    textObject: [statusBarContainer()],
    listObject: [menuList],
  }
}

// --- Navigation -----------------------------------------------------------

function openTool(index: number) {
  if (index < 0 || index >= TOOLS.length) return
  const tool = TOOLS[index]
  bridge
    .rebuildPageContainer(new RebuildPageContainer(toolContainers(index)))
    .then(ok => {
      if (ok) {
        screen = { kind: 'tool', index }
        persistScreen(screen)
        status(`Tool: ${tool.name}`)
        // Started only after the page is on screen. Anything a tool does to the
        // content area needs the container to exist first.
        tool.onOpen?.()
      } else {
        status(`Failed to open ${tool.name}`)
      }
    })
}

function returnToMenu() {
  // Close before the rebuild, so an update arriving mid-transition cannot land on
  // a container that is about to be replaced.
  activeTool()?.onClose?.()
  bridge
    .rebuildPageContainer(new RebuildPageContainer(menuContainers()))
    .then(ok => {
      if (ok) {
        screen = { kind: 'menu' }
        persistScreen(screen)
        status('Menu')
      } else {
        // Back failed. Exit rather than leave the wearer stuck.
        requestExit()
      }
    })
}

// Request the system exit confirmation dialog.
//
// Mode 1, not 0: the QA guidelines require the confirmation dialog on the root
// page, and explicitly reject both silent exit (mode 0) and a custom in-app
// confirm.
//
// shutDownPageContainer returns Promise<boolean>. A false result means the wearer
// double-tapped and got nothing, which is exactly the rejection scenario the root
// double-tap exists to prevent. Surface it.
function requestExit() {
  bridge.shutDownPageContainer(1).then(ok => {
    if (!ok) status('Exit request failed: shutDownPageContainer returned false')
  })
}

// --- Startup --------------------------------------------------------------
//
// A cold start after Android suspend re-runs this module from scratch, so
// whatever happens here also defines the cold-start experience.
//
// Every read races a timeout, because a read that never settles would block the
// event handler registration below.
const storedScreenPromise = readWithTimeout(readStoredScreen(), null)
const hydrationPromise = Promise.all([
  hydrateStatusBar(),
  ...TOOLS.map(tool => tool.hydrate?.()),
])

// Show the menu first. It is the safe default and every path that does not
// restore lands here anyway. Creating it before the reads resolve means the first
// frame is never blocked on storage.
const result = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer(menuContainers()),
)

// Page creation result.
//
// Hardware is the source of truth here. On real glasses this succeeds, which
// proves the payload is valid. In the simulator and a plain browser, code 1
// appears non-deterministically: sometimes on first load, sometimes on refresh,
// sometimes not at all. See README "Page creation in the simulator and browser"
// and issue #11.
//
// Deliberately no retry. Adding one would touch the path that works on hardware
// in order to quiet an environment where failure is expected.
if (result === 0) {
  status('Page created: success. Check the glasses display.')
} else {
  status(
    `Page creation returned code ${result} (1 invalid, 2 oversize, 3 out of memory). ` +
      `On hardware this is a real problem. In the simulator and plain browser, ` +
      `code 1 is expected and does not indicate a problem with the app.`,
  )
}

await hydrationPromise
const restoredScreen = await storedScreenPromise

// If a recent tool page was stored, rebuild to it. The menu was already shown;
// the rebuild causes a brief flicker during cold start, which is the trade for
// never blocking the first frame on a storage read.
if (restoredScreen && restoredScreen.kind === 'tool') {
  const tool = TOOLS[restoredScreen.index]
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
    status(`Restored: ${tool.name}`)
    tool.onOpen?.()
  } else {
    status(`Failed to restore ${tool.name}`)
  }
}

// Refresh the persisted screen's timestamp. If we restored to a tool, this
// carries the new "current"; if we stayed on the menu, it stamps menu as current
// so a subsequent quick suspend-resume correctly lands here. Without this, a
// string of quick resumes would expire after the original window elapsed, even
// though the wearer never left the app for long.
persistScreen(screen)

// Start the clock last, once the config has loaded and whichever page we are
// showing has settled. startStatusBar refreshes immediately, so this is also what
// corrects the bar from defaults to the stored config.
startStatusBar()

// --- Input ----------------------------------------------------------------

// Reads the event type out of one envelope.
//
// CLICK_EVENT is 0, and protobuf omits zero-value fields on the wire, so a single
// tap arrives as an envelope whose `eventType` is `undefined`. The default has to
// be resolved INSIDE the envelope check. Writing
// `event.sysEvent?.eventType ?? CLICK_EVENT` instead would read CLICK on events
// that carry no `sysEvent` at all, so every scroll, exit and audio frame would
// fire the tap handler.
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
//   1. Double-tap -> back. On a tool page that means the menu; on the menu there
//      is nowhere further back, so it means exit. Must be first so nothing below
//      can swallow the one gesture that guarantees the wearer can leave.
//   2. Foreground enter and exit -> resume and suspend the active tool and the
//      clock.
//   3. listEvent click on the menu -> open the highlighted tool.
//   4. Scroll on a tool page -> the tool's onScroll, if it has one.
//   5. Exit events -> close the active tool, unsubscribe.
//
// Tap on a tool page reaches the tool only through onScroll today. Tap is defined
// as "forward" in the gesture rules and is free for a tool to claim.
const unsubscribe = bridge.onEvenHubEvent(event => {
  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)
  const listType = eventTypeOf(event.listEvent)

  const isDoubleTap =
    sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    textType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    listType === OsEventTypeList.DOUBLE_CLICK_EVENT

  if (isDoubleTap) {
    if (screen.kind === 'tool') {
      returnToMenu()
    } else {
      // Menu, or any state we do not recognise. This is deliberately not
      // `screen.kind === 'menu'`: anything that is not a confirmed tool page
      // falls through to exit, so a screen variant added later defaults to
      // escapable rather than stranded. That is the guarantee the branch used to
      // get for free by being unconditional.
      requestExit()
    }
    return
  }

  // Foreground return. The clock is stale by however long we were away and is on
  // screen on every page, so it gets corrected first. The active tool may have
  // had a subscription stopped under it by the OS.
  if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
    startStatusBar()
    activeTool()?.onResume?.()
    return
  }

  // Going to background. Stop what the wearer cannot see.
  if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
    activeTool()?.onSuspend?.()
    stopStatusBar()
    return
  }

  // currentSelectItemIndex is 0 for the first item, and protobuf elides zero
  // values, so tapping the first row can arrive as `undefined`. Resolve the
  // default INSIDE the branch where we already know listEvent exists and the
  // event is a click.
  const listEvent = event.listEvent
  if (listEvent && listType === OsEventTypeList.CLICK_EVENT && screen.kind === 'menu') {
    openTool(listEvent.currentSelectItemIndex ?? 0)
    return
  }

  // Scroll on a tool page. SCROLL_TOP_EVENT and SCROLL_BOTTOM_EVENT are 1 and 2,
  // both non-zero, so the zero-elision trap does not apply here.
  const tool = activeTool()
  if (tool?.onScroll) {
    if (textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      tool.onScroll(1)
      return
    }
    if (textType === OsEventTypeList.SCROLL_TOP_EVENT) {
      tool.onScroll(-1)
      return
    }
  }

  // OS-initiated exit. Best-effort: the WebView may be torn down before the event
  // reaches us, so this is not guaranteed to run. If it does, it saves the host
  // from continuing to stream after we are gone.
  if (
    sysType === OsEventTypeList.SYSTEM_EXIT_EVENT ||
    sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT
  ) {
    activeTool()?.onClose?.()
    stopStatusBar()
    unsubscribe()
  }
})
