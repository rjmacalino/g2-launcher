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
  BRIGHTNESS_DIMMED,
  BRIGHTNESS_NORMAL,
  CONTAINER_ID_MODAL,
  CONTAINER_NAME_MODAL,
  CONTENT_Y,
  MODAL_HEIGHT,
  MODAL_WIDTH,
  MODAL_X,
  MODAL_Y,
  PADDING,
  Z_CONTENT,
  Z_MODAL,
  setContentBrightness,
  setModalText,
} from './page'
import { readWithTimeout } from './storage'
import {
  hydrate as hydrateStatusBar,
  startStatusBar,
  statusBarContainers,
  stopStatusBar,
} from './statusbar'
import { persistScreen, readStoredScreen, type Screen } from './screen'
import { TOOLS, TOOL_NAMES } from './tools'

// The shell. Owns which page is showing, builds pages, and routes input. It knows
// tools only through the Tool interface, so adding one is a new file plus an entry
// in the TOOLS array rather than a new branch in here.

let screen: Screen = { kind: 'menu' }

function activeTool() {
  return screen.kind === 'tool' ? TOOLS[screen.index] : null
}

// Whether the active tool is currently asking whether to leave, and which answer
// is selected.
//
// Not part of Screen, and deliberately not persisted. A cold start should never
// restore the wearer into a half-answered question about a page they cannot
// remember opening.
let confirming = false

// 0 is No, 1 is Yes. Defaults to No every time the prompt opens, so the dangerous
// answer is never the one already selected when a wearer taps without reading.
const CONFIRM_NO = 0
const CONFIRM_YES = 1
let confirmChoice: 0 | 1 = CONFIRM_NO

// A marker you move beats a gesture you have to be told about.
//
// Labels are padded to a common width so the marker holds one column. Otherwise
// it tracks the label length and appears to jump sideways as the selection
// moves, which reads as the marker being unstable rather than the selection
// changing.
function confirmText(toolName: string): string {
  const row = (label: string, value: 0 | 1) =>
    `${label.padEnd(3)} ${confirmChoice === value ? '<' : ''}`.trimEnd()
  return `End ${toolName}

${row('No', CONFIRM_NO)}
${row('Yes', CONFIRM_YES)}`
}

// Open the prompt.
//
// The tool's own container is never written to. It is dimmed instead, with a
// brightness-only upgrade that carries no content, because any upgrade carrying
// content resets the firmware's scroll and costs the wearer their place. Dimming
// leaves the tool exactly where it was and gives the faded backdrop a modal
// wants anyway.
// Sequenced, not fired together. Two upgrades dispatched at once and one of them
// is dropped: the first version did both concurrently and the brightness change
// came back rejected, leaving the tool at full brightness behind the modal. The
// docs warn about this for image sends ("no concurrent sends") and it holds for
// text upgrades too.
//
// Dim first, then draw, so there is never a frame where the modal is up over an
// undimmed tool.
function enterConfirm(toolName: string) {
  confirming = true
  confirmChoice = CONFIRM_NO
  setContentBrightness(BRIGHTNESS_DIMMED).then(() => {
    setModalText(confirmText(toolName))
  })
}

function moveConfirm(next: 0 | 1, toolName: string) {
  if (confirmChoice === next) return
  confirmChoice = next
  setModalText(confirmText(toolName))
}

// Dismiss the prompt. Clearing the modal and restoring brightness, with the tool
// untouched throughout, so the wearer is returned to exactly the line they were
// reading rather than to the top.
// Clear the modal first, then restore brightness, for the same sequencing reason
// and so the tool is never briefly readable with the prompt still on top of it.
function cancelConfirm() {
  confirming = false
  setModalText('').then(() => {
    setContentBrightness(BRIGHTNESS_NORMAL)
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
  zOrderIndex: Z_CONTENT,
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
  const bar = statusBarContainers()
  return {
    containerTotalNum: bar.length + 2,
    textObject: [
      ...bar,
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
        zOrderIndex: Z_CONTENT,
        isEventCapture: 1,
      }),
      // The modal, empty. It has to exist from page creation because adding a
      // container later means a rebuild, and a rebuild resets scroll.
      //
      // NO BORDER, and that is not an aesthetic choice. A border draws whether or
      // not the container has text, and TextContainerUpgrade carries no border
      // fields, so a bordered container is bordered permanently. The first
      // version of this had a 2px border and left an empty rectangle sitting over
      // the script on every tool page.
      //
      // Only the text can be turned off, by writing an empty string. So the modal
      // has to be made of text alone, and the separation from the tool behind it
      // comes from brightness: the tool dims to 0, the modal draws at 4.
      new TextContainerProperty({
        xPosition: MODAL_X,
        yPosition: MODAL_Y,
        width: MODAL_WIDTH,
        height: MODAL_HEIGHT,
        borderWidth: 0,
        paddingLength: 8,
        textColor: BRIGHTNESS_NORMAL,
        containerID: CONTAINER_ID_MODAL,
        containerName: CONTAINER_NAME_MODAL,
        content: '',
        zOrderIndex: Z_MODAL,
        isEventCapture: 0,
      }),
    ],
  }
}

function menuContainers() {
  const bar = statusBarContainers()
  return {
    containerTotalNum: bar.length + 1,
    textObject: bar,
    listObject: [menuList],
  }
}

// --- Navigation -----------------------------------------------------------

function openTool(index: number) {
  if (index < 0 || index >= TOOLS.length) return
  // Any navigation clears the prompt. Cheaper to reset unconditionally here than
  // to reason about every path that could reach a new page with a stale flag set.
  // The page is rebuilt below, which draws a fresh empty modal container, so
  // there is nothing left over to clear.
  confirming = false
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
      const tool = TOOLS[screen.index]
      // Double tap means back, and from the prompt back is the tool you came
      // from. So the same gesture that raised the question also dismisses it.
      if (confirming) {
        cancelConfirm()
        return
      }
      if (tool.confirmOnExit) {
        enterConfirm(tool.name)
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

  // The leave prompt. Scroll moves the marker, tap takes the selected answer,
  // which is the same vocabulary as the launcher menu rather than a special case
  // the wearer has to be taught.
  //
  // Everything here is swallowed, including gestures that mean nothing, so no
  // input reaches the tool behind the prompt while a question is open.
  if (confirming) {
    const tool = activeTool()
    if (!tool) {
      // Cannot happen: confirming is only ever set on a tool page and every
      // navigation clears it. Bail rather than trap the wearer behind a prompt
      // with nothing to answer for.
      confirming = false
      return
    }

    if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
      if (confirmChoice === CONFIRM_YES) {
        returnToMenu()
      } else {
        cancelConfirm()
      }
      return
    }

    // Two options, so up is always No and down is always Yes. Absolute rather
    // than a toggle: scrolling up twice should leave you on No, not flip you
    // back to Yes, and a wearer who is not sure which way they scrolled can
    // press up and know where they landed.
    if (textType === OsEventTypeList.SCROLL_TOP_EVENT) {
      moveConfirm(CONFIRM_NO, tool.name)
    } else if (textType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      moveConfirm(CONFIRM_YES, tool.name)
    }
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
