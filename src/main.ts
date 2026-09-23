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
  CONFIRM_LIST_HEIGHT,
  CONFIRM_LIST_Y,
  CONFIRM_TITLE_HEIGHT,
  CONFIRM_TITLE_Y,
  CONTAINER_ID_CONFIRM_TITLE,
  CONTAINER_ID_CONTENT,
  CONTAINER_NAME_CONFIRM_TITLE,
  CONTAINER_NAME_CONTENT,
  CONTENT_HEIGHT,
  CONTENT_Y,
  LIST_ITEM_WIDTH,
  PADDING,
} from './page'
import { readWithTimeout } from './storage'
import {
  hydrate as hydrateStatusBar,
  startStatusBar,
  statusBarContainers,
  stopStatusBar,
} from './statusbar'
import { registerRebuildHandler } from './rebuild'
import { persistScreen, readStoredScreen, type Screen } from './screen'
import { TOOLS, TOOL_NAMES, type Tool } from './tools'
import { start as startWeather, stop as stopWeather } from './weather-service'

// The shell. Owns which page is showing, builds pages, and routes input. It knows
// tools only through the Tool interface, so adding one is a new file plus an entry
// in the TOOLS array rather than a new branch in here.

let screen: Screen = { kind: 'menu' }

function activeTool() {
  return screen.kind === 'tool' ? TOOLS[screen.index] : null
}

// Whether the active tool is currently asking whether to leave.
//
// Not part of Screen, and deliberately not persisted. A cold start should never
// restore the wearer into a half-answered question about a page they cannot
// remember opening.
let confirming = false

// A native list, the same widget the launcher menu and the Teleprompter picker
// already use. Firmware owns highlight, scroll and boundary bounce, so it
// bounces correctly only at the real ends of No/Yes, unlike the hand-drawn "<"
// marker this replaces, which had to fake selection by re-pushing text on every
// scroll tick and bounced on every single move because that text never
// overflowed its own container.
//
// This is not a new position-loss cost. Entering confirm already replaced the
// content container regardless of representation - a plain text swap resets
// the firmware's scroll exactly as a rebuild does, both being a content
// change - so a native list costs nothing beyond what showing any confirm
// prompt already cost. The only thing that changes here is which widget draws
// it and whether its bounce behaviour is real.
//
// No is index 0, Yes is index 1. Firmware defaults a fresh list's highlight to
// index 0, so the dangerous answer is never pre-selected without any code
// having to arrange it.
const CONFIRM_NO = 0
const CONFIRM_YES = 1

function confirmContainers(tool: Tool) {
  const bar = statusBarContainers()
  return {
    containerTotalNum: bar.length + 2,
    textObject: [
      ...bar,
      new TextContainerProperty({
        xPosition: 0,
        yPosition: CONFIRM_TITLE_Y,
        width: CANVAS_WIDTH,
        height: CONFIRM_TITLE_HEIGHT,
        borderWidth: 0,
        // No padding: the box is already sized to exactly one row, so any
        // internal padding on top of that just re-adds the gap the height
        // change was meant to remove.
        paddingLength: 0,
        containerID: CONTAINER_ID_CONFIRM_TITLE,
        containerName: CONTAINER_NAME_CONFIRM_TITLE,
        content: tool.confirmPrompt?.() ?? `Leave ${tool.name}?`,
        isEventCapture: 0,
      }),
    ],
    listObject: [
      new ListContainerProperty({
        xPosition: 0,
        yPosition: CONFIRM_LIST_Y,
        width: CANVAS_WIDTH,
        height: CONFIRM_LIST_HEIGHT,
        borderWidth: 0,
        // Same reasoning: no top padding to add back space right where the
        // title was just tightened to remove it.
        paddingLength: 0,
        containerID: CONTAINER_ID_CONTENT,
        containerName: CONTAINER_NAME_CONTENT,
        isEventCapture: 1,
        itemContainer: new ListItemContainerProperty({
          itemCount: 2,
          itemWidth: LIST_ITEM_WIDTH,
          isItemSelectBorderEn: 1,
          itemName: ['No', 'Yes'],
        }),
      }),
    ],
  }
}

function enterConfirm(tool: Tool) {
  bridge.rebuildPageContainer(new RebuildPageContainer(confirmContainers(tool))).then(ok => {
    if (ok) {
      confirming = true
    } else {
      status('Failed to open leave prompt')
    }
  })
}

// No: rebuild back to the tool exactly as it was, unchanged since entering
// confirm never touched its internal state.
function cancelConfirm(index: number) {
  bridge.rebuildPageContainer(new RebuildPageContainer(toolContainers(index))).then(ok => {
    if (ok) {
      confirming = false
    } else {
      requestExit()
    }
  })
}

// Yes: ask the tool where "leaving" actually goes. Most tools have no answer
// for this and default to the menu; Teleprompter uses it to step back to its
// own picker instead of exiting itself entirely (see onConfirmedExit in
// types.ts). Either way the tool's own onConfirmedExit runs first, so its
// internal state is already updated by the time the rebuild reads it.
function confirmExit(tool: Tool, index: number) {
  confirming = false
  const destination = tool.onConfirmedExit?.() ?? 'menu'
  if (destination === 'menu') {
    returnToMenu()
    return
  }
  bridge.rebuildPageContainer(new RebuildPageContainer(toolContainers(index))).then(ok => {
    if (ok) {
      status(`Tool: ${tool.name}`)
    } else {
      status(`Failed to update ${tool.name}`)
    }
  })
}

// Ceiling on the restore rebuild. Anything awaited between page creation and
// event handler registration can strand the wearer if it never settles: the menu
// is already drawn, so the glasses show a healthy app that listens to nothing,
// and root double-tap does nothing, which is the documented rejection trigger.
const RESTORE_REBUILD_TIMEOUT_MS = 5000

// --- Pages ----------------------------------------------------------------
//
// Every page is the status bar plus exactly one content container. The bar is
// built by statusBarContainers() in both builders below, which is what makes a
// page without a bar impossible to construct.
//
// containerTotalNum counts the bar's slots plus the one content container, so it
// is derived rather than written down. A hardcoded count here would go stale the
// next time the bar gains or loses a slot, and the failure would be a rejected
// page rather than an obviously wrong number.

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
    itemWidth: LIST_ITEM_WIDTH,
    isItemSelectBorderEn: 1,
    itemName: [...TOOL_NAMES],
  }),
})

// The content container MUST set isEventCapture: 1. A page with no capture
// container has no way out, and it is also the container the firmware scrolls and
// the one every tool's setContent targets. Full CONTENT_HEIGHT, no reserved
// space: see page.ts for why a permanently smaller reading area was tried and
// reverted.
//
// A tool can ask for its content slot as a list instead of text (see
// Tool.contentKind in types.ts). Only Teleprompter uses this today, for its
// script picker, and it is the same ListContainerProperty shape as the menu:
// firmware owns highlight and scroll, we only react to a click.
function toolListContent(tool: Tool): ListContainerProperty {
  const items = tool.listItems?.() ?? []
  return new ListContainerProperty({
    xPosition: 0,
    yPosition: CONTENT_Y,
    width: CANVAS_WIDTH,
    height: CONTENT_HEIGHT,
    borderWidth: 0,
    paddingLength: PADDING,
    containerID: CONTAINER_ID_CONTENT,
    containerName: CONTAINER_NAME_CONTENT,
    isEventCapture: 1,
    itemContainer: new ListItemContainerProperty({
      itemCount: items.length,
      itemWidth: LIST_ITEM_WIDTH,
      isItemSelectBorderEn: 1,
      itemName: items,
    }),
  })
}

function toolTextContent(tool: Tool): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: CONTENT_Y,
    width: CANVAS_WIDTH,
    height: CONTENT_HEIGHT,
    borderWidth: 0,
    paddingLength: PADDING,
    containerID: CONTAINER_ID_CONTENT,
    containerName: CONTAINER_NAME_CONTENT,
    content: tool.initialContent(),
    isEventCapture: 1,
  })
}

function toolContainers(index: number) {
  const tool = TOOLS[index]
  const bar = statusBarContainers()

  if ((tool.contentKind?.() ?? 'text') === 'list') {
    return {
      containerTotalNum: bar.length + 1,
      textObject: bar,
      listObject: [toolListContent(tool)],
    }
  }

  return {
    containerTotalNum: bar.length + 1,
    textObject: [...bar, toolTextContent(tool)],
  }
}

// A tool's data changed out from under it (see rebuild.ts) and wants its own
// page redrawn. Verified here, not trusted from the caller: only rebuild if
// the given tool is actually the one on screen right now, and not while a
// leave prompt is open, so a background data update can never clobber
// whatever the wearer is currently looking at or answering.
registerRebuildHandler(tool => {
  if (confirming) return
  if (screen.kind !== 'tool') return
  if (TOOLS[screen.index] !== tool) return
  bridge.rebuildPageContainer(new RebuildPageContainer(toolContainers(screen.index))).then(ok => {
    if (!ok) status(`Failed to update ${tool.name}`)
  })
})

function menuContainers() {
  const bar = statusBarContainers()
  return {
    containerTotalNum: bar.length + 1,
    textObject: bar,
    listObject: [menuList],
  }
}

// --- Navigation -----------------------------------------------------------

async function openTool(index: number) {
  if (index < 0 || index >= TOOLS.length) return
  // Any navigation clears the prompt. Cheaper to reset unconditionally here than
  // to reason about every path that could reach a new page with a stale flag set.
  // The page is rebuilt below, which draws a fresh empty modal container, so
  // there is nothing left over to clear.
  confirming = false
  const tool = TOOLS[index]

  // Awaited before the page is built, so contentKind/listItems/initialContent
  // (all synchronous, see types.ts) have current data the instant they run.
  // Teleprompter uses this to read the latest saved scripts for its picker.
  await tool.beforeOpen?.()

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
  confirming = false
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
  // Same reason as openTool: contentKind/listItems/initialContent need fresh
  // data before toolContainers reads them, and this is the other place that
  // reads them.
  await tool.beforeOpen?.()
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

// Same lifecycle as the clock: runs for as long as the app is foregrounded,
// independent of which tool is on screen, because the status bar's weather
// slot needs current conditions on every page, not only while Weather itself
// is open.
startWeather()

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
//   1. The leave prompt, if open, intercepts EVERYTHING, including double-tap.
//      This has to come before the double-tap-exits check below, not after:
//      while the prompt is showing, tap and double-tap both mean "take the
//      highlighted answer", not "go back" or "exit". No is on the list, so
//      selecting it and tapping already cancels; a separate cancel gesture
//      would be redundant and would make double-tap behave inconsistently
//      depending on whether a prompt happens to be open.
//   2. Double-tap -> back. On a tool page that means the menu; on the menu
//      there is nowhere further back, so it means exit. Must be first among
//      the remaining checks so nothing below can swallow the one gesture that
//      guarantees the wearer can leave.
//   3. Foreground enter and exit -> resume and suspend the active tool and the
//      clock.
//   4. listEvent click on the menu -> open the highlighted tool.
//   5. listEvent click inside a tool's own list content -> the tool's
//      onListSelect, if it has one.
//   6. Long press on a tool page -> the tool's onLongPress, if it has one.
//   7. Scroll on a tool page -> the tool's onScroll, if it has one.
//   8. Exit events -> close the active tool, unsubscribe.
//
// Tap on a tool page reaches the tool only through onListSelect (list content)
// or onScroll (text content) today. Tap is defined as "forward" in the gesture
// rules and is free for a tool to claim either way.
const unsubscribe = bridge.onEvenHubEvent(event => {
  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)
  const listType = eventTypeOf(event.listEvent)
  const listEvent = event.listEvent

  const isDoubleTap =
    sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    textType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    listType === OsEventTypeList.DOUBLE_CLICK_EVENT

  // The leave prompt. A native list (see confirmContainers), so scroll and
  // highlight are entirely firmware's job; we only react once something is
  // chosen. A plain click and a double-click both commit whatever is
  // currently highlighted, matching the earlier decision that a separate
  // cancel gesture is redundant once No is a selectable, defaulted-to answer.
  //
  // Catching DOUBLE_CLICK_EVENT here, before the isDoubleTap branch below, is
  // what stops an accidental double-tap while the prompt is open from falling
  // through to the exit/back logic meant for when no prompt is showing.
  if (confirming && screen.kind === 'tool') {
    if (listEvent && (listType === OsEventTypeList.CLICK_EVENT || listType === OsEventTypeList.DOUBLE_CLICK_EVENT)) {
      const tool = TOOLS[screen.index]
      const choice = listEvent.currentSelectItemIndex ?? CONFIRM_NO
      if (choice === CONFIRM_YES) {
        confirmExit(tool, screen.index)
      } else {
        cancelConfirm(screen.index)
      }
    }
    // Anything else while the prompt is open (scroll, an unrelated event) is
    // swallowed here: firmware already handles scroll on the list itself, and
    // nothing else should reach the tool underneath while a question is open.
    return
  }

  if (isDoubleTap) {
    if (screen.kind === 'tool') {
      const tool = TOOLS[screen.index]
      if (tool.confirmOnExit?.()) {
        enterConfirm(tool)
        return
      }
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
    startWeather()
    activeTool()?.onResume?.()
    return
  }

  // Going to background. Stop what the wearer cannot see.
  if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
    activeTool()?.onSuspend?.()
    stopStatusBar()
    stopWeather()
    return
  }

  // currentSelectItemIndex is 0 for the first item, and protobuf elides zero
  // values, so tapping the first row can arrive as `undefined`. Resolve the
  // default INSIDE the branch where we already know listEvent exists and the
  // event is a click.
  if (listEvent && listType === OsEventTypeList.CLICK_EVENT && screen.kind === 'menu') {
    openTool(listEvent.currentSelectItemIndex ?? 0)
    return
  }

  // A list click inside a tool's own content area (not the launcher menu).
  // Only reachable when that tool's contentKind() is 'list', since that is the
  // only way a tool page ever gets a list container in the first place.
  //
  // The tool updates its own internal state in onListSelect, then the shell
  // rebuilds the SAME tool slot so the page reflects whatever contentKind,
  // listItems or initialContent now return. This is a fresh page the wearer
  // has not started reading yet, not a scrolled document, so a rebuild here
  // costs nothing the way it would inside an open teleprompter.
  if (listEvent && listType === OsEventTypeList.CLICK_EVENT && screen.kind === 'tool') {
    const tool = TOOLS[screen.index]
    if ((tool.contentKind?.() ?? 'text') === 'list') {
      const index = listEvent.currentSelectItemIndex ?? 0
      tool.onListSelect?.(index)
      bridge
        .rebuildPageContainer(new RebuildPageContainer(toolContainers(screen.index)))
        .then(ok => {
          if (!ok) status(`Failed to update ${tool.name}`)
        })
      return
    }
  }

  // Long press on a tool page. Free for a tool to claim (see the gesture
  // rules): neither forward nor back, so it is where an action that is
  // genuinely neither belongs. LONG_PRESS_EVENT is 9, non-zero, so the
  // zero-elision trap does not apply here either.
  if (sysType === OsEventTypeList.LONG_PRESS_EVENT) {
    activeTool()?.onLongPress?.()
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
