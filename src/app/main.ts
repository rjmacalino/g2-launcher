import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
} from '@evenrealities/even_hub_sdk'
import { bridge, status } from '../platform/bridge'
import {
  CANVAS_WIDTH,
  CONFIRM_LIST_HEIGHT,
  CONFIRM_LIST_Y,
  CONFIRM_TITLE_HEIGHT,
  CONFIRM_TITLE_Y,
  CONTAINER_ID_CONFIRM_TITLE,
  CONTAINER_ID_CONTENT,
  CONTAINER_ID_CONTENT_IMAGE,
  CONTAINER_NAME_CONFIRM_TITLE,
  CONTAINER_NAME_CONTENT,
  CONTAINER_NAME_CONTENT_IMAGE,
  CONTENT_HEIGHT,
  CONTENT_Y,
  IMAGE_MAX_HEIGHT,
  IMAGE_MAX_WIDTH,
  LIST_ITEM_WIDTH,
  PADDING,
} from '../platform/page'
import { readWithTimeout } from '../platform/storage'
import {
  hydrate as hydrateStatusBar,
  setTimer as setStatusBarTimer,
  setWeather as setStatusBarWeather,
  startStatusBar,
  statusBarContainers,
  stopStatusBar,
} from './statusbar'
import { registerRebuildHandler } from '../core/rebuild'
import { onScreenRequest, publishToolScreen, setCurrentScreen } from '../core/currentScreen'
import { persistScreen, readStoredScreen, type Screen } from './screen'
import { TOOLS, TOOL_NAMES } from './registry'
import type { Tool } from '../core/tool'
import {
  getCurrent as getCurrentWeather,
  onUpdate as onWeatherUpdate,
  start as startWeather,
  stop as stopWeather,
} from '../features/weather/service'
import {
  getTimer,
  onBackground as suspendTimerTicking,
  onForeground as resumeTimerTicking,
  onUpdate as onTimerUpdate,
  onExpired as onTimerExpired,
  remainingMs as timerRemainingMs,
} from '../features/timer/service'
import { parseVoiceCommand } from '../features/timer/voiceCommand'
import {
  cancelTimerAction,
  pauseTimerAction,
  resumeTimerAction,
  startTimerAction,
  timerActions,
  timerStatusAction,
} from '../features/timer/actions'
import { describeLists, notesActions } from '../features/notes/actions'
import { notes } from '../features/notes/store'
import { registerVoiceDispatch } from '../core/voiceDispatch'
import { registerAssistantActions } from '../core/assistantActions'
import { registerConversationDigest, registerConversationSaver } from '../core/assistantContext'
import { newId } from '../platform/collection'
import { buildDigest } from '../features/chat/digest'
import { preload as preloadWhisper } from '../core/whisper'
import { chatSessions } from '../features/chat/store'
import {
  finishListening as finishJarvisListening,
  isListening as isJarvisListening,
  canRetry as canRetryJarvis,
  retry as retryJarvis,
  prepareOpen as prepareJarvisOpen,
  isAtPicker as isJarvisAtPicker,
  onReturnRequested as onJarvisReturnRequested,
  armWakeListen as armJarvisWakeListen,
  isBusy as isJarvisBusy,
} from '../features/chat/tool'
import { startWakeListening, stopWakeListening } from '../core/wakeListener'
import { isWakeWordEnabled, onWakeSettingChanged } from '../core/wakeSettings'
import { micResumed, micSuspended } from '../core/mic'
import { describeDuration, formatDuration } from '../shared/duration'

// The shell. Owns which page is showing, builds pages, and routes input. It knows
// tools only through the Tool interface, so adding one is a new file plus an entry
// in the TOOLS array rather than a new branch in here.

let screen: Screen = { kind: 'menu' }

// Where the wearer was before a long-press took them into Jarvis, so they
// can be handed back afterward instead of stranded in Jarvis or dumped at
// the menu (see enterJarvis and returnFromJarvis below). Set only by
// enterJarvis; cleared once used, and on any return to the menu.
let screenBeforeJarvis: Screen | null = null

function activeTool() {
  return screen.kind === 'tool' ? TOOLS[screen.index] : null
}

// Whether the active tool is currently asking whether to leave.
//
// Not part of Screen, and deliberately not persisted. A cold start should never
// restore the wearer into a half-answered question about a page they cannot
// remember opening.
let confirming = false

// Whether the "Time's up!" alert is covering the page (see showTimerAlert).
// Same standing as confirming: not part of Screen, never persisted - the
// screen underneath is still the one the wearer is on, and dismissing the
// alert just redraws it.
let alerting = false

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

// Rebuilds the same tool slot in place rather than leaving it - what "Yes"
// on a leave prompt uses once a tool's own onConfirmedExit has decided
// double-tap means "step back one level", not "exit". The tool's own state
// (depth, selection, whatever) is assumed already updated by the caller
// before this runs, same as any other rebuild triggered by a tool's own hook.
function rebuildToolInPlace(tool: Tool, index: number) {
  bridge.rebuildPageContainer(new RebuildPageContainer(toolContainers(index))).then(ok => {
    if (ok) {
      status(`Tool: ${tool.name}`)
      tool.onContentReady?.()
    } else {
      status(`Failed to update ${tool.name}`)
    }
  })
}

// Yes: ask the tool where "leaving" actually goes. Most tools have no answer
// for this and default to the menu; Teleprompter uses it to step back to its
// own picker instead of exiting itself entirely (see onConfirmedExit in
// core/tool.ts). Either way the tool's own onConfirmedExit runs first, so its
// internal state is already updated by the time the rebuild reads it.
function confirmExit(tool: Tool, index: number) {
  confirming = false
  const destination = tool.onConfirmedExit?.() ?? 'menu'
  if (destination === 'menu') {
    // Leaving a Jarvis conversation that a long-press started from another
    // screen goes back to that screen, not the menu.
    if (index === JARVIS_INDEX && screenBeforeJarvis) {
      returnFromJarvis()
      return
    }
    returnToMenu()
    return
  }
  rebuildToolInPlace(tool, index)
}

// Ceiling on the restore rebuild. Anything awaited between page creation and
// event handler registration can strand the wearer if it never settles: the menu
// is already drawn, so the glasses show a healthy app that listens to nothing,
// and root double-tap does nothing, which is the documented rejection trigger.
const RESTORE_REBUILD_TIMEOUT_MS = 5000

// Same ceiling, for a tool's own beforeOpen - awaited in openTool (and the
// restore path above) before the container is even built, with nothing
// bounding how long that wait can run. Found the hard way [HW]: Chat's own
// beforeOpen reads one storage key holding every saved session as a single
// JSON blob (see features/chat/store.ts), and once that grew large enough,
// tapping Chat did NOTHING AT ALL - not even a "Failed to open" status,
// because the await never returned to reach the code that would have shown
// one. The real fix is bounding that blob (store.ts now prunes old
// sessions on every write); this is the generic backstop so the SAME
// silent hang, from this or any future tool's beforeOpen, fails loudly
// instead of looking like a dead launcher entry with no error anywhere to
// explain why.
//
// Reports WHY, not just whether, it failed - a plain boolean here would
// have hidden the exact thing that mattered when Chat's open from the menu
// failed again even after the storage cap above landed: whether beforeOpen
// genuinely ran past the timeout, or threw something specific and fast.
// Those point at completely different bugs, and guessing between them
// without hardware access to test against is how a fix misses twice.
type BeforeOpenOutcome = { ok: true } | { ok: false; reason: string }

function beforeOpenWithTimeout(tool: Tool): Promise<BeforeOpenOutcome> {
  if (!tool.beforeOpen) return Promise.resolve({ ok: true })
  return Promise.race([
    tool.beforeOpen().then((): BeforeOpenOutcome => ({ ok: true })),
    new Promise<BeforeOpenOutcome>(resolve => {
      setTimeout(() => resolve({ ok: false, reason: 'timed out' }), RESTORE_REBUILD_TIMEOUT_MS)
    }),
  ]).catch((e: unknown): BeforeOpenOutcome => ({
    ok: false,
    reason: e instanceof Error ? e.message : String(e),
  }))
}

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
// space: see platform/page.ts for why a permanently smaller reading area was tried and
// reverted.
//
// A tool can ask for its content slot as a list instead of text (see
// Tool.contentKind in core/tool.ts). Only Teleprompter uses this today, for its
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

// The invisible capture layer behind an 'image' page. Image containers
// cannot set isEventCapture (see ImageContainerProperty in the SDK), so a
// tap, double-tap and scroll all still need a real container behind the
// image to land on - full content area, blank content, same trick the
// official image template and even-g2-notes both document.
function toolImageCapture(): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0,
    yPosition: CONTENT_Y,
    width: CANVAS_WIDTH,
    height: CONTENT_HEIGHT,
    borderWidth: 0,
    paddingLength: 0,
    containerID: CONTAINER_ID_CONTENT,
    containerName: CONTAINER_NAME_CONTENT,
    content: ' ',
    isEventCapture: 1,
  })
}

// The image container itself, empty. A tool fills it after the page is on
// screen, via setImage() in platform/page.ts - see Tool.imageSize in
// core/tool.ts for why this cannot happen at creation. Centred in the
// content area at whatever size the tool asked for, clamped to the one
// container maximum this platform allows.
function toolImageContent(tool: Tool): ImageContainerProperty {
  const size = tool.imageSize?.() ?? { width: IMAGE_MAX_WIDTH, height: IMAGE_MAX_HEIGHT }
  const width = Math.min(size.width, IMAGE_MAX_WIDTH)
  const height = Math.min(size.height, IMAGE_MAX_HEIGHT)
  return new ImageContainerProperty({
    xPosition: Math.floor((CANVAS_WIDTH - width) / 2),
    yPosition: CONTENT_Y + Math.floor((CONTENT_HEIGHT - height) / 2),
    width,
    height,
    containerID: CONTAINER_ID_CONTENT_IMAGE,
    containerName: CONTAINER_NAME_CONTENT_IMAGE,
  })
}

// Re-declared on every rebuild that shows this tool - omitting it clears any
// previous custom items (see Tool.contextMenu in core/tool.ts), so there is
// no "leave the old menu alone" option to accidentally take.
function toolMenu(tool: Tool): MenuContainerProperty | undefined {
  const items = tool.contextMenu?.() ?? []
  if (items.length === 0) return undefined
  return new MenuContainerProperty({
    menuItems: items.map(i => new MenuItemProperty({ itemName: i.itemName, itemID: i.itemID })),
  })
}

function toolContainers(index: number) {
  const tool = TOOLS[index]
  const bar = statusBarContainers()
  const kind = tool.contentKind?.() ?? 'text'
  const menuObject = toolMenu(tool)

  if (kind === 'list') {
    return {
      containerTotalNum: bar.length + 1,
      textObject: bar,
      listObject: [toolListContent(tool)],
      menuObject,
    }
  }

  if (kind === 'image') {
    return {
      containerTotalNum: bar.length + 2,
      textObject: [...bar, toolImageCapture()],
      imageObject: [toolImageContent(tool)],
      menuObject,
    }
  }

  return {
    containerTotalNum: bar.length + 1,
    textObject: [...bar, toolTextContent(tool)],
    menuObject,
  }
}

// A tool's data changed out from under it (see core/rebuild.ts) and wants its own
// page redrawn. Verified here, not trusted from the caller: only rebuild if
// the given tool is actually the one on screen right now, and not while a
// leave prompt is open, so a background data update can never clobber
// whatever the wearer is currently looking at or answering.
// The companion page asking the glasses to go somewhere (G2-69): the phone
// steers, the glasses follow, using the same navigation a gesture would -
// so what the glasses end up showing is announced back through
// setCurrentScreen exactly as if the wearer had done it on the glasses.
// Overrides whatever the glasses were in the middle of, the leave prompt
// and timer alert included: a choice made on the phone is deliberate.
onScreenRequest(request => {
  if (request.kind === 'menu') {
    if (screen.kind !== 'menu' || confirming || alerting) returnToMenu()
    return
  }
  const index = TOOLS.findIndex(t => t.name === request.name)
  if (index < 0) return
  const tool = TOOLS[index]
  if (screen.kind === 'tool' && screen.index === index && !confirming && !alerting) {
    if (tool.showDetail?.(request.detail, true)) {
      bridge.rebuildPageContainer(new RebuildPageContainer(toolContainers(index))).then(ok => {
        if (!ok) status(`Failed to update ${tool.name}`)
        else tool.onContentReady?.()
      })
    }
    publishToolScreen(tool)
    return
  }
  tool.showDetail?.(request.detail, false)
  // openTool does not close the outgoing tool (see enterJarvis).
  activeTool()?.onClose?.()
  screenBeforeJarvis = null
  void openTool(index)
})

registerRebuildHandler(tool => {
  if (confirming || alerting) return
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

// Computed once: -1 would mean Jarvis is missing from TOOLS entirely, which
// would be a registry.ts bug, not something to silently tolerate here.
const JARVIS_INDEX = TOOLS.findIndex(t => t.name === 'Jarvis')

// A long-press from any screen other than Jarvis: straight into a new
// Jarvis conversation, recording, remembering where to hand the wearer back
// to afterward (see returnFromJarvis).
function enterJarvis() {
  screenBeforeJarvis = screen
  // openTool does not call the outgoing tool's onClose - every other path
  // into a tool comes from the menu, where there is no tool open to close.
  activeTool()?.onClose?.()
  prepareJarvisOpen('quickAsk')
  openTool(JARVIS_INDEX)
}

// A new Jarvis question from wherever the wearer is: the long-press
// gesture, and "Hey Jarvis" (G2-64), which does exactly the same thing.
// Inside Jarvis: on its list it opens a new conversation, staying in
// Jarvis rather than treating the list as a screen to come back to; in a
// conversation it asks the next question there (Jarvis's own onLongPress).
// Anywhere else: a new conversation, handing back afterward.
function askJarvis() {
  if (screen.kind === 'tool' && screen.index === JARVIS_INDEX) {
    if (isJarvisAtPicker()) {
      prepareJarvisOpen('newChat')
      openTool(JARVIS_INDEX)
    } else {
      activeTool()?.onLongPress?.()
    }
    return
  }
  enterJarvis()
}

// Foreground state, for whether "Hey Jarvis" may act: the mic is stopped
// in the background anyway, but a wake already in flight from just before
// must not open Jarvis on a page nobody is looking at.
let inForeground = true

// Never on top of something the wearer is in the middle of: a recording,
// transcription or answer already under way (saying "Jarvis" inside a
// question must not start a second one), the leave prompt, the timer
// alert, Lab, whose probes hold the mic for their own measurements, or
// Jarvis Live, where "Jarvis" said in conversation is just a word.
const NO_WAKE_TOOLS = new Set(['Lab', 'Jarvis Live'])

function canWake(): boolean {
  return (
    inForeground &&
    !confirming &&
    !alerting &&
    !NO_WAKE_TOOLS.has(activeTool()?.name ?? '') &&
    !isJarvisBusy()
  )
}

function handleWake() {
  status('Jarvis: heard "Hey Jarvis"')
  armJarvisWakeListen()
  askJarvis()
}

async function applyWakeSetting(enabled: boolean) {
  if (!enabled) {
    stopWakeListening()
    status('"Hey Jarvis" is off')
    return
  }
  const ok = await startWakeListening({ onWake: handleWake, canWake })
  status(ok ? 'Listening for "Hey Jarvis"' : '"Hey Jarvis" could not start the microphone')
}

// Back to wherever the long-press into Jarvis came from - after a command
// has run, or on leaving a conversation it started.
function returnFromJarvis() {
  const target = screenBeforeJarvis
  screenBeforeJarvis = null
  if (!target || target.kind === 'menu') {
    returnToMenu()
    return
  }
  activeTool()?.onClose?.()
  openTool(target.index)
}

async function openTool(index: number) {
  if (index < 0 || index >= TOOLS.length) return
  // Any navigation clears the prompt. Cheaper to reset unconditionally here than
  // to reason about every path that could reach a new page with a stale flag set.
  // The page is rebuilt below, which draws a fresh empty modal container, so
  // there is nothing left over to clear. Same for the timer alert.
  confirming = false
  alerting = false
  const tool = TOOLS[index]

  // Awaited before the page is built, so contentKind/listItems/initialContent
  // (all synchronous, see core/tool.ts) have current data the instant they run.
  // Teleprompter uses this to read the latest saved scripts for its picker.
  // Bounded (see beforeOpenWithTimeout above) so a stuck read fails loudly
  // instead of leaving the tap looking like it did nothing at all.
  const beforeOpenResult = await beforeOpenWithTimeout(tool)
  if (!beforeOpenResult.ok) {
    status(`Failed to open ${tool.name}: ${beforeOpenResult.reason}`)
    return
  }

  bridge.rebuildPageContainer(new RebuildPageContainer(toolContainers(index))).then(ok => {
    if (ok) {
      screen = { kind: 'tool', index }
      // Jarvis is persisted like any other tool now. The old one-shot
      // Jarvis was not, because restoring into it started listening with no
      // gesture at all [HW]; Jarvis now records only when opened by a
      // long-press or "New chat", never on a restore (see
      // features/chat/tool.ts's prepareOpen - a restore opens the list).
      persistScreen(screen)
      status(`Tool: ${tool.name}`)
      // Baseline publish before onOpen, not after - a tool with its own
      // internal depth worth mirroring (Chat; see core/currentScreen.ts)
      // republishes with its own detail from onOpen, and that has to be
      // the LAST write to land, not this one, or the companion would lose
      // the detail moment it was just given.
      publishToolScreen(tool)
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
  alerting = false
  // Back at the top: nothing left to hand the wearer back to.
  screenBeforeJarvis = null
  // Close before the rebuild, so an update arriving mid-transition cannot land on
  // a container that is about to be replaced.
  activeTool()?.onClose?.()
  bridge.rebuildPageContainer(new RebuildPageContainer(menuContainers())).then(ok => {
    if (ok) {
      screen = { kind: 'menu' }
      persistScreen(screen)
      status('Menu')
      setCurrentScreen({ kind: 'menu' })
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
const hydrationPromise = Promise.all([hydrateStatusBar(), ...TOOLS.map(tool => tool.hydrate?.())])

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
const storedScreen = await storedScreenPromise

// Jarvis Live starts listening the moment it opens, so it is never
// restored into: a cold start or a return from the background must not
// switch on conversation listening without the wearer choosing it, the
// same lesson as the old one-shot Jarvis [HW, G2-54]. Also covers a stored
// index from before Live was added at position 1, which would otherwise
// restore "Notes" into Live.
const restoredScreen =
  storedScreen?.kind === 'tool' && TOOLS[storedScreen.index]?.name === 'Jarvis Live'
    ? null
    : storedScreen

// If a recent tool page was stored, rebuild to it. The menu was already shown;
// the rebuild causes a brief flicker during cold start, which is the trade for
// never blocking the first frame on a storage read. Restoring into Jarvis
// opens its list - it never starts recording without a gesture.
if (restoredScreen && restoredScreen.kind === 'tool') {
  const tool = TOOLS[restoredScreen.index]
  // Same reason as openTool: contentKind/listItems/initialContent need fresh
  // data before toolContainers reads them, and this is the other place that
  // reads them. Bounded the same way (see beforeOpenWithTimeout) - this is
  // cold start, before the menu has even settled, so a hang here is the
  // worst place for one to go unnoticed.
  const beforeOpenResult = await beforeOpenWithTimeout(tool)
  const ok =
    beforeOpenResult.ok &&
    (await Promise.race([
      bridge.rebuildPageContainer(new RebuildPageContainer(toolContainers(restoredScreen.index))),
      new Promise<boolean>(resolve => {
        setTimeout(() => resolve(false), RESTORE_REBUILD_TIMEOUT_MS)
      }),
    ]))
  if (ok) {
    screen = restoredScreen
    status(`Restored: ${tool.name}`)
    // Same ordering as openTool: baseline before onOpen, so a tool that
    // republishes its own detail from onOpen (Chat) has the last word.
    publishToolScreen(tool)
    tool.onOpen?.()
  } else if (!beforeOpenResult.ok) {
    status(`Failed to restore ${tool.name}: ${beforeOpenResult.reason}`)
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
// is open. The shell connects the two so neither module knows about the other.
onWeatherUpdate(() => setStatusBarWeather(getCurrentWeather()))
startWeather()

// Same shape as the weather wiring just above: the shell connects the timer
// service to the status bar so neither module knows about the other. Unlike
// weather there is no startTimer() call here - the service already started
// its own ticking during hydrate() (above, inside hydrationPromise) if a
// timer was already running when the app launched. The immediate call below
// covers the gap between that hydrate and this subscription being wired: an
// active timer must show correctly on the very first status bar paint, not
// only from its first tick up to a second later.
function timerBarText(): string | null {
  const state = getTimer()
  if (state.status === 'idle') return null
  const remaining = formatDuration(timerRemainingMs(Date.now()))
  return state.status === 'paused' ? `Paused ${remaining}` : remaining
}
onTimerUpdate(() => setStatusBarTimer(timerBarText()))
setStatusBarTimer(timerBarText())

// Jarvis's local commands. Jarvis captures speech but has no idea what a
// transcript means as a command - which feature a command belongs to is
// app-level knowledge (see core/voiceDispatch.ts for why). Today just the
// Timer. Anything that is not a command is not handled here: Jarvis sends
// it to Gemini itself, as part of its conversation (features/chat/tool.ts).
registerVoiceDispatch(async transcript => {
  const command = parseVoiceCommand(transcript)
  switch (command.kind) {
    case 'startTimer':
      return { handled: true, message: startTimerAction(command.durationMs) }
    case 'cancelTimer':
      return { handled: true, message: cancelTimerAction() }
    case 'pauseTimer':
      return { handled: true, message: pauseTimerAction() }
    case 'resumeTimer':
      return { handled: true, message: resumeTimerAction() }
    case 'timerStatus':
      return { handled: true, message: timerStatusAction() }
    case 'unrecognized':
      return { handled: false }
  }
})

// What Jarvis can do beyond answering, through Gemini (see
// core/assistantActions.ts): everything the fast path above does not
// recognise - lists, and timer requests phrased any other way ("five
// minutes" in words, "a quarter of an hour"). The context is the names of
// the wearer's lists, so Gemini uses an existing one rather than inventing
// a near-duplicate.
// Jarvis Live's cues know the wearer's other conversations the same way
// Jarvis does: through the digest of saved chats, handed over here because
// features never import each other.
registerConversationDigest(() => buildDigest(chatSessions.peek() ?? [], null))
// ...and a finished Jarvis Live conversation is saved into Jarvis's own
// history, where the wearer can open it and ask about it.
registerConversationSaver(conversation =>
  chatSessions.save({
    id: newId(),
    title: conversation.title,
    messages: conversation.messages,
    updatedAt: Date.now(),
  }),
)

registerAssistantActions({
  actions: [...notesActions, ...timerActions],
  context: async () => describeLists(await notes.readAll()),
})

// --- Time's up -------------------------------------------------------------

// The timer used to say "Time's up!" only on its own screen, which is off
// the launcher now - started by voice, a timer would otherwise end with
// nothing but its status bar countdown quietly disappearing. So the end of a
// timer takes over whatever page is showing until the wearer taps, the same
// way the leave prompt does. Visual only, per decision (docs/roadmap.md):
// nothing here can make a sound or vibrate. And only while the app is in
// the foreground - a timer that ends while the wearer is elsewhere is
// announced the moment they come back (the service's first tick after
// foregrounding notices it), with how long ago it ended.
//
// Its own container id, deliberately not the tool content's: a tool still
// running underneath (Jarvis's Thinking counter, say) keeps sending text
// updates to the content container, and those must not land on the alert.
// They fail harmlessly against a page that has no such container instead.
function timerAlertContainers(lateMs: number) {
  const bar = statusBarContainers()
  const ended =
    lateMs >= 60_000
      ? `Your timer ended ${describeDuration(Math.round(lateMs / 60_000) * 60_000)} ago.`
      : 'Your timer has finished.'
  return {
    containerTotalNum: bar.length + 1,
    textObject: [
      ...bar,
      new TextContainerProperty({
        xPosition: 0,
        yPosition: CONTENT_Y,
        width: CANVAS_WIDTH,
        height: CONTENT_HEIGHT,
        borderWidth: 0,
        paddingLength: PADDING,
        containerID: CONTAINER_ID_CONFIRM_TITLE,
        containerName: CONTAINER_NAME_CONFIRM_TITLE,
        content: `Time's up!\n\n${ended}\n\nTap to dismiss`,
        isEventCapture: 1,
      }),
    ],
  }
}

function showTimerAlert(lateMs: number) {
  // The Timer screen shows its own "Time's up!" - no second one on top.
  if (activeTool()?.name === 'Timer') return
  bridge.rebuildPageContainer(new RebuildPageContainer(timerAlertContainers(lateMs))).then(ok => {
    if (ok) {
      // A leave prompt that was open is gone now - dismissing returns to
      // the page itself, not to the question.
      confirming = false
      alerting = true
      status("Timer: time's up")
    } else {
      status("Timer: time's up (failed to show the alert)")
    }
  })
}

function dismissTimerAlert() {
  const containers = screen.kind === 'tool' ? toolContainers(screen.index) : menuContainers()
  bridge.rebuildPageContainer(new RebuildPageContainer(containers)).then(ok => {
    if (!ok) {
      // Still showing the alert, which still takes taps - the next tap
      // tries again rather than leaving the wearer on a page that
      // ignores them.
      status('Failed to dismiss the timer alert - tap again')
      return
    }
    alerting = false
    if (screen.kind === 'tool') TOOLS[screen.index].onContentReady?.()
  })
}

onTimerExpired(showTimerAlert)

// Kicked off here, not awaited, and not gated behind ever opening Jarvis:
// loading the Whisper model takes real time (confirmed by Lab's probe), so
// starting it during startup gives it a head start against the moment the
// wearer actually opens Jarvis, rather than starting cold at that moment. A
// slow or failed load must not block startup, which is exactly what
// preload() itself already guarantees (see core/whisper.ts).
preloadWhisper()

// "Hey Jarvis" listening, unless turned off on the companion page, which
// can also switch it on and off while the app runs.
onWakeSettingChanged(enabled => void applyWakeSetting(enabled))
void isWakeWordEnabled().then(enabled => {
  if (enabled) void applyWakeSetting(true)
})

// Same idea for Jarvis's saved conversations: loaded once in the background
// so opening Jarvis reads an in-memory copy instead of storage (see
// features/chat/store.ts for why a storage read on that path is exactly
// what kept making it fail to open).
chatSessions.preload()

// Jarvis asks for this once a command started by a long-press has shown its
// result (it owns the delay, and checks the wearer has not started
// something else meanwhile). Rechecked here too: only if Jarvis is still
// the page on screen and there is somewhere to go back to - the wearer may
// have navigated away on purpose in the meantime.
onJarvisReturnRequested(() => {
  // Leaving now would replace a "Time's up!" the wearer has not seen yet.
  if (alerting) return
  if (!(screen.kind === 'tool' && screen.index === JARVIS_INDEX)) return
  if (!screenBeforeJarvis) return
  returnFromJarvis()
})

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
//   8. Contextual menu item click -> the tool's onMenuItemClick, if it has one.
//   9. Exit events -> close the active tool, unsubscribe.
//
// Tap on a tool page reaches the tool only through onListSelect (list content)
// or onScroll (text content) today. Tap is defined as "forward" in the gesture
// rules and is free for a tool to claim either way.
//
// Opening or closing the contextual menu also fires FOREGROUND_EXIT_EVENT
// and FOREGROUND_ENTER_EVENT (per docs/platform.md, Contextual menu) - step 3
// already handles those unconditionally, so a tool's onSuspend/onResume also
// fire around a menu open, same as they would around the app actually
// backgrounding. Not distinguished from real backgrounding, on purpose: the
// SDK gives no way to tell the two apart, and treating them the same is the
// safe default (a tool that stops a subscription for a real background exit
// stopping it for a menu open too is a conservative miss, not a bug).
const unsubscribe = bridge.onEvenHubEvent(event => {
  // Self-healing against the clock silently stopping forever. Reported
  // directly [HW]: the status bar clock stuck several minutes behind
  // while the app was otherwise clearly alive and responding to input -
  // meaning startStatusBar's own setInterval had stopped (FOREGROUND_EXIT_
  // EVENT fired, see below) with no matching FOREGROUND_ENTER_EVENT ever
  // following to restart it. That pairing is already flagged elsewhere in
  // this file as fragile - opening or closing the contextual menu fires
  // the SAME pair of events, so a lost or doubled one during that is a
  // real, plausible way to end up here, not just a theory. startStatusBar
  // is already a no-op when its timer is running, so calling it on every
  // single event this handler receives costs nothing in the normal case
  // and guarantees the clock can never get stuck off while the app is
  // still processing input at all - the actual trigger does not need to
  // be pinned down for this to be the right fix.
  startStatusBar()

  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)
  const listType = eventTypeOf(event.listEvent)
  const listEvent = event.listEvent

  const isDoubleTap =
    sysType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    textType === OsEventTypeList.DOUBLE_CLICK_EVENT ||
    listType === OsEventTypeList.DOUBLE_CLICK_EVENT

  // The "Time's up!" alert covers the page: any tap or double-tap dismisses
  // it - a double-tap must not also count as "back" on the page underneath,
  // which the wearer cannot even see right now. Long press and scroll do
  // nothing while it is up. Foreground enter/exit still fall through: the
  // clock, weather and the tool underneath need them regardless.
  if (alerting) {
    const isTap =
      isDoubleTap ||
      sysType === OsEventTypeList.CLICK_EVENT ||
      textType === OsEventTypeList.CLICK_EVENT ||
      listType === OsEventTypeList.CLICK_EVENT
    if (isTap) {
      dismissTimerAlert()
      return
    }
    const isLifecycle =
      sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT ||
      sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT
    if (!isLifecycle) return
  }

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
    if (
      listEvent &&
      (listType === OsEventTypeList.CLICK_EVENT || listType === OsEventTypeList.DOUBLE_CLICK_EVENT)
    ) {
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

  // A single tap in Jarvis has two meanings, neither of which is "leave" -
  // per direct request, double-tap felt wrong for ending a recording, and
  // re-speaking a question just to retry after a Gemini failure is the
  // wrong recovery path. Checked before the isDoubleTap branch below so it
  // does not fall through to the universal "tap does nothing on a text
  // screen" default. isDoubleTap is excluded explicitly so a genuine
  // double-tap still falls through to the normal leave-confirmation
  // behaviour below. (The old one-shot Jarvis ended a recording with a
  // double-press instead; that tool is gone, merged into this one.)
  const isSingleTap =
    !isDoubleTap &&
    (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT)
  if (isSingleTap && screen.kind === 'tool' && screen.index === JARVIS_INDEX) {
    if (isJarvisListening()) {
      finishJarvisListening()
      return
    }
    if (canRetryJarvis()) {
      retryJarvis()
      return
    }
  }

  // Any other tool that wants a plain tap on its text page.
  if (isSingleTap && screen.kind === 'tool') {
    const tool = TOOLS[screen.index]
    if (tool.onTap && tool.contentKind?.() !== 'list') {
      tool.onTap()
      return
    }
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
    inForeground = true
    micResumed()
    startStatusBar()
    startWeather()
    resumeTimerTicking()
    activeTool()?.onResume?.()
    return
  }

  // Going to background. Stop what the wearer cannot see.
  if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
    inForeground = false
    micSuspended()
    activeTool()?.onSuspend?.()
    stopStatusBar()
    stopWeather()
    suspendTimerTicking()
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
          if (ok) {
            tool.onContentReady?.()
          } else {
            status(`Failed to update ${tool.name}`)
          }
        })
      return
    }
  }

  // Long press, reserved globally for Jarvis: from any screen it starts a
  // new Jarvis conversation, recording. Per direct decision, this takes
  // plain long press away from every tool that used to be free to claim it
  // (only Notes did, moved to its own contextual menu item - see
  // features/notes/tool.ts). Inside Jarvis itself: in a conversation it
  // asks the next question (Jarvis's own onLongPress); on Jarvis's list it
  // opens a new conversation, staying in Jarvis rather than treating the
  // list as a screen to come back to. Lab, dev-only and never shipped,
  // keeps it for its own hardware probes. LONG_PRESS_EVENT is 9, non-zero,
  // so the zero-elision trap does not apply here.
  //
  // Recording ends on a tap (see the isSingleTap branch above), not on the
  // matching LONG_PRESS_RELEASE_EVENT - tried release first, and per direct
  // report holding the whole time a question was spoken ended the
  // recording too early. LONG_PRESS_RELEASE_EVENT is deliberately unhandled.
  if (sysType === OsEventTypeList.LONG_PRESS_EVENT) {
    const tool = activeTool()
    if (tool?.name === 'Lab') {
      tool.onLongPress?.()
    } else {
      askJarvis()
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

  // Contextual menu item click. Only reachable when the active tool declared
  // custom items via contextMenu() (see toolMenu above) - the system's own
  // Display off / Brightness / Close slots do not surface a click event to
  // us at all, only ours do.
  if (event.menuItemClickEvent) {
    activeTool()?.onMenuItemClick?.(event.menuItemClickEvent.itemID ?? 0)
    return
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
