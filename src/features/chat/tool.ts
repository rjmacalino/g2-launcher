import { modelLabel } from '../../core/llmProviders'
import { isCodeFontLoaded, loadCodeFont } from '../../ui/codeFont'
import { cancel, start, stop } from '../../core/voiceCapture'
import { engineDescription } from '../../core/whisper'
import { takePreroll } from '../../core/wakeListener'
import { dispatchVoiceCommand } from '../../core/voiceDispatch'
import { runAssistantActions } from '../../core/assistantActions'
import { describeModel } from '../../core/llm'
import { getLlmConfig, providerInfo } from '../../core/llmSettings'
import { chatSessions, type ChatMessage, type ChatSession } from './store'
import { setContent } from '../../platform/page'
import { status } from '../../platform/bridge'
import { PAGE_INNER_WIDTH, paginate, rebuildSafe, type Page } from './paging'
import { splitAnswer } from '../../shared/answerBlocks'
import { codeScreens, layoutCode } from '../../shared/codeLayout'
import { CODE_FONT_PX, codeMetrics, renderCodeTiles, type CodeMetrics } from '../../ui/codeRender'
import { nextTileBank, setTiles } from '../../platform/page'
import { askAssistant } from './assistant'
import { setCurrentScreen } from '../../core/currentScreen'
import { requestRebuild } from '../../core/rebuild'
import type { Tool } from '../../core/tool'

// JARVIS - the one assistant. Per direct request, what used to be two tools
// (Jarvis, the quick long-press-from-anywhere command runner, and Gemini,
// the conversation tool) is now one, named Jarvis: ask it questions, or
// give it commands like a timer. Gemini is the model behind the answers,
// not the name of the tool. (This file still lives under features/chat -
// the module path is internal; what the wearer sees is the tool's name.)
//
// Three ways in (see app/main.ts and prepareOpen below):
// - From the launcher: the chat list ("New chat" plus saved conversations).
// - Long-press from any other screen ("quick ask"): straight into a new
//   conversation, recording. A command (a timer) runs locally, shows its
//   result and hands the wearer back to where they were, the way the old
//   Jarvis did; a command from a blank start is not saved as a
//   conversation, so timers do not clutter the history. Lists and anything
//   the local parser misses are commands too, decided by Gemini (see
//   core/assistantActions.ts) and treated the same way. A question goes to
//   Gemini and stays on screen to be read and followed up; leaving it
//   returns to where the long-press came from rather than to the list.
// - Long-press on the chat list: a new conversation, recording.
//
// Two depths, same shape as Notes/Teleprompter's own picker/detail split:
// 'picker' lists "New chat" plus every saved session by title, 'conversation'
// is the transcript. Same confirm-before-leaving convention as
// Teleprompter, per direct request to always follow it consistently:
// double-tap always backs up exactly one level, and always asks first,
// regardless of whether anything would actually be lost (everything here
// is already saved to storage the moment it happens - the prompt is about
// "did you mean that", not "is data at risk"). See confirmOnExit,
// confirmPrompt and onConfirmedExit below, which mirror Teleprompter's own
// implementation exactly.
//
// Inside a conversation, long-press asks the next question, and a single tap
// ends the recording - per direct request, double-tap felt wrong for that
// (see the isSingleTap carve-out in app/main.ts).
type Depth = 'picker' | 'conversation'
let depth: Depth = 'picker'

// How the NEXT open should start - set by the shell just before it opens
// this tool (see the ways in above), consumed by refresh().
export type OpenMode = 'picker' | 'newChat' | 'quickAsk'
let nextOpenMode: OpenMode = 'picker'

export function prepareOpen(mode: OpenMode): void {
  nextOpenMode = mode
}

// This conversation was started by a long-press from another screen, so
// leaving it (or a finished command) returns the wearer there.
let quickAsk = false

export function isAtPicker(): boolean {
  return depth === 'picker'
}

// The shell's "take the wearer back to where they long-pressed from" -
// registered at startup (see app/main.ts), the same callback pattern as
// core/rebuild.ts, since this module cannot import the shell.
let returnHandler: (() => void) | null = null

export function onReturnRequested(fn: () => void): void {
  returnHandler = fn
}

// How long a finished command's result stays up before the wearer is
// handed back - long enough to read "Started a 5:00 timer.", short enough
// that "it just does it" does not turn into "and now I am stuck here".
const COMMAND_RETURN_DELAY_MS = 2500

// Cached for the current open only, refreshed in beforeOpen - contentKind,
// listItems and initialContent are all synchronous, so the data has to
// already be here before they run (same reasoning as every other
// picker-based tool in this app). Kept as full sessions, not just titles,
// so picking one in onListSelect (itself synchronous - see the Tool
// interface) can hand currentMessages its real history directly instead of
// a second async storage read landing after the rebuild already happened.
let pickerSessions: ChatSession[] = []

// The open conversation, held here in memory as the source of truth while
// it is open - storage is only ever written in the background from this
// (see saveCurrent below and features/chat/store.ts for why nothing the
// wearer waits on touches storage). null id means "New chat" was picked and
// no question has been asked yet, so no session exists.
let currentSessionId: string | null = null
let currentMessages: ChatMessage[] = []
let currentSessionTitle: string | null = null

// Background save of whatever conversation is open. Never awaited: the
// store waits for its own startup load before writing (so it can never
// overwrite history it has not seen), and that wait must not reach the
// screen.
function saveCurrent(): void {
  if (currentSessionId === null) return
  void chatSessions.save({
    id: currentSessionId,
    title: currentSessionTitle ?? '(untitled)',
    messages: currentMessages,
    updatedAt: Date.now(),
  })
}

let sessionToken = 0
let listening = false

export function isListening(): boolean {
  return listening
}

// The question Gemini most recently failed to answer, so a single tap can
// retry it without making the wearer re-record the same thing - per
// direct request, re-speaking a question just to get the same network
// error again is the wrong recovery path. null whenever there is nothing
// to retry: cleared on a successful answer, on leaving the conversation
// (onBack), on picking a different session, and before starting a fresh
// recording - a retry only ever means "try this exact failed question
// again", never "retry whatever happens to be last".
let lastErrorQuestion: string | null = null

export function canRetry(): boolean {
  return lastErrorQuestion !== null
}

// What companion/main.ts reads back out of core/currentScreen.ts's opaque
// `detail` field to decide what the companion's own, richer Chat view
// should show - exported as a type so companion can read it with no
// runtime coupling beyond the one setCurrentScreen call below. Per direct
// instruction: the glasses are the extension, the companion is where the
// same app shows its fuller page, so whichever depth Chat is actually in
// on the glasses, the companion should be showing the matching page, not
// whatever was last clicked into on the phone.
export type ChatScreenDetail =
  { depth: 'picker' } | { depth: 'conversation'; sessionId: string | null }

// Called everywhere depth or currentSessionId changes: refresh, picking an
// item in the picker, stepping back via onBack, and after a voice exchange
// either creates a brand new session or continues an existing one. Also
// called from onOpen/onContentReady so it is always the LAST write for
// this tool's own screen entry, after the shell's own generic baseline
// publish (see app/main.ts's setCurrentScreen calls) - that ordering is
// what stops the baseline from clobbering this richer detail.
function screenDetail(): ChatScreenDetail {
  return depth === 'picker'
    ? { depth: 'picker' }
    : { depth: 'conversation', sessionId: currentSessionId }
}

function publishScreen(): void {
  setCurrentScreen({ kind: 'tool', name: 'Jarvis', detail: screenDetail() })
}

// A saved conversation the companion page asked for before Jarvis was open
// (G2-69); refresh() opens straight into it, to read, not to record.
let openSessionId: string | null = null

function isChatDetail(x: unknown): x is ChatScreenDetail {
  return !!x && typeof x === 'object' && 'depth' in x
}

// Shows a saved conversation, or the list when id is null or unknown.
function showSession(id: string | null): void {
  codeView = null
  const session = id ? (chatSessions.peek() ?? []).find(s => s.id === id) : undefined
  pages = []
  lastErrorQuestion = null
  interrupted = false
  quickAsk = false
  listenWhenReady = false
  if (!session) {
    depth = 'picker'
    currentSessionId = null
    currentMessages = []
    currentSessionTitle = null
    pickerSessions = sortForPicker(chatSessions.peek() ?? [])
    return
  }
  depth = 'conversation'
  currentSessionId = session.id
  currentMessages = session.messages
  currentSessionTitle = session.title
}

// List containers have a firmware hard limit of 20 items (docs/platform.md).
// "New chat" is always the first row, leaving 19 for saved sessions - after
// enough testing/real use to pass that count, listItems() returning more
// than 20 total made the firmware reject the rebuild outright, which looked
// like Chat silently refusing to open at all [HW], not like a list that
// needed trimming. Only the picker is capped; nothing is deleted, and the
// companion page's own chat-view (see companion/main.ts) has no such limit
// and still shows every session.
const PICKER_MAX_SESSIONS = 19

// Shorter than the 64-character list-item limit on purpose. Both open
// Gemini bugs [HW] - failing to open, and "Yes" on the leave prompt not
// landing back on this picker - only ever happened with saved chats, i.e.
// only when this list had titles in it; with zero chats it is just "New
// chat" and both always worked. Titles were cut at exactly 64 characters,
// right on the documented limit, so a firmware that really allows 63 plus a
// terminator would reject every long-question title. Unconfirmed, but the
// stored title is untouched - only what the list shows is shorter.
const PICKER_TITLE_MAX_CHARS = 40

function pickerTitle(title: string): string {
  return title.length > PICKER_TITLE_MAX_CHARS
    ? `${title.slice(0, PICKER_TITLE_MAX_CHARS - 3)}...`
    : title
}

function sortForPicker(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, PICKER_MAX_SESSIONS)
}

// No storage read on this path any more - it reads the store's in-memory
// copy, loaded once in the background at app startup (see
// features/chat/store.ts for why: a storage read here is exactly what was
// timing out the whole open). If that load has not finished yet, the
// picker opens with just "New chat" and redraws itself the moment the
// saved chats arrive, rather than holding the open hostage to them.
async function refresh(): Promise<void> {
  const mode = nextOpenMode
  nextOpenMode = 'picker'
  quickAsk = mode === 'quickAsk'
  // The chat list, or - for a long-press - straight into a new
  // conversation, recording as soon as its page is on screen (see
  // startIfPending).
  depth = mode === 'picker' ? 'picker' : 'conversation'
  listenWhenReady = mode !== 'picker'
  currentSessionId = null
  currentMessages = []
  currentSessionTitle = null
  lastErrorQuestion = null
  interrupted = false
  pages = []
  const cached = chatSessions.peek()
  pickerSessions = sortForPicker(cached ?? [])
  if (openSessionId) {
    showSession(openSessionId)
    openSessionId = null
  }
  if (cached === null) {
    void chatSessions.readAll().then(loaded => {
      pickerSessions = sortForPicker(loaded)
      // Only the list needs redrawing; the shell ignores this unless
      // Jarvis is actually the page on screen (see app/main.ts's rebuild
      // handler).
      if (depth === 'picker') requestRebuild(chatTool, fillSection)
    })
  }
}

// Folds the currently open session back into pickerSessions in memory, no
// storage read needed - this just keeps the in-memory picker list from
// showing stale data (a missing new session, or an old title/position) on
// the way back to it. Called from onConfirmedExit, which must be
// synchronous (same requirement as onListSelect).
function syncPickerFromCurrent(): void {
  if (currentSessionId === null) return
  const updated: ChatSession = {
    id: currentSessionId,
    title: currentSessionTitle ?? '(untitled)',
    messages: currentMessages,
    updatedAt: Date.now(),
  }
  const index = pickerSessions.findIndex(s => s.id === currentSessionId)
  const withoutCurrent =
    index === -1 ? pickerSessions : pickerSessions.filter((_, i) => i !== index)
  // Capped the same way refresh() is (see PICKER_MAX_SESSIONS above) - a
  // brand new session landing here via "New chat" could otherwise push the
  // in-memory list back past the firmware's 20-item limit without a full
  // tool reopen (which is the only other place this gets capped) ever
  // running to catch it.
  pickerSessions = [updated, ...withoutCurrent].slice(0, PICKER_MAX_SESSIONS)
}

// THE FULL ANSWER, PAGED - per direct request: show all of it on the
// glasses, never cut it, never send the wearer to the companion page.
//
// One screen update cannot carry an arbitrarily long answer: the firmware
// rejects a text update past its own hard ceiling (docs/platform.md: 1000
// characters on create/rebuild, 2000 on an in-place upgrade). So the latest
// exchange (question, divider, answer) is laid out into pages of about two
// screens each (features/chat/paging.ts, pure and tested). Within a page
// the firmware scrolls smoothly on its own; only a swipe past a page's end
// changes the page (see onScroll below). Every page is under either
// ceiling, so answer length is unlimited.

// Questions can now run to three minutes of speech (core/voiceCapture.ts) -
// thousands of characters. The full question is part of the paged view;
// status screens (Thinking, errors) show just its start, so they stay well
// inside one update and one screen.
const STATUS_QUESTION_MAX_CHARS = 160

function shortQuestion(question: string): string {
  return question.length > STATUS_QUESTION_MAX_CHARS
    ? `${question.slice(0, STATUS_QUESTION_MAX_CHARS - 3)}...`
    : question
}

// The pages currently on screen, and which one is showing. Empty whenever
// something other than the conversation is on screen (listening, thinking,
// an error), so a swipe there does nothing.
let pages: Page[] = []
let pageIndex = 0

// Page turning, per direct report that one-screen pages turned on every
// swipe and lost the wearer's place. The firmware scrolls a page smoothly
// on its own and reports only a swipe at its top or bottom edge
// (even-g2-notes, docs/input-events.md). Whether that report comes on the
// swipe that ARRIVES at the edge or only on a further swipe once already
// there is not documented - so the first edge report only arms the turn
// and a second one turns the page. Either way the wearer gets to read the
// page's last lines before it changes, rather than the page vanishing the
// instant they come into view. A page small enough to be seen whole turns
// on the first report, since there is nothing left on it to read.
//
// Same source: "Scroll events can fire rapidly. Use a cooldown" - without
// one, a single swipe could deliver both reports and turn the page anyway.
const SCROLL_COOLDOWN_MS = 400
let lastScrollAt = 0

// A short horizontal rule between the question and the answer - U+2500,
// confirmed available in the firmware font (docs/platform.md's glyph
// table). A blank line alone looks identical to a paragraph break INSIDE a
// longer answer, which makes a multi-paragraph reply hard to tell apart
// from the question above it; this divider is the one mark on screen that
// only ever means "new speaker", never "new paragraph". Kept short (12
// chars) rather than spanning the line - a measured, intentional rule
// reads more clearly at this size than a long one that may not even line
// up with the text's own wrapped width, which this app has no way to
// measure exactly (see docs/platform.md, proportional font).
const DIVIDER = '\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n'

// The latest answer only (G2-97: the question took the whole first screen
// and the wearer already knows what they asked - it is on the phone). An
// unanswered question is shown, short, since there is no answer yet.
// Earlier exchanges in the same conversation are on the companion page. Returns the FIRST page and
// resets paging to it, so a new answer always opens at its start.
function renderConversation(): string {
  return renderExchange(currentMessages)
}

// renderConversation's work, for any list of messages - also used to show
// a command's result that is not part of a saved conversation (see
// finishListening).
function renderExchange(messages: readonly ChatMessage[]): string {
  if (messages.length === 0) {
    pages = []
    // Shown for the moment between picking "New chat" and the microphone
    // starting (see startIfPending), rather than an instruction to
    // long-press that is about to be done for the wearer anyway.
    return listenWhenReady
      ? 'Starting the microphone...'
      : 'No messages yet.\n\nLong-press to ask something.'
  }
  const last = messages[messages.length - 1]
  codeBlocks = []
  const parts =
    last.role === 'model'
      ? [`${last.model ? `${last.model}: ` : ''}${withCodePlaceholders(last.text)}`]
      : [`You: ${shortQuestion(last.text)}`]
  pages = paginate(parts.join(DIVIDER), PAGE_INNER_WIDTH)
  pageIndex = 0
  warmCode()
  return pages[0].text
}

// THE CODE VIEW (G2-73). The glasses' own text has one proportional font,
// which scrambles code, so code in an answer is drawn as pictures instead
// (ui/codeRender.ts) in a real monospace font, at the size chosen on the
// phone. In the text view each code block is a one-line placeholder; a tap
// opens the code view, a swipe or tap pages through it, and a double-tap
// returns to the text.
let codeBlocks: string[] = []
type CodeView = { block: number; screen: number; screens: string[][]; metrics: CodeMetrics }
let codeView: CodeView | null = null
let drawing = false
let drawAgain = false

function withCodePlaceholders(text: string): string {
  const blocks = splitAnswer(text)
  if (!blocks.some(b => b.kind === 'code')) return text
  const total = blocks.filter(b => b.kind === 'code').length
  return blocks
    .map(block => {
      if (block.kind === 'text') return block.text
      codeBlocks.push(block.text)
      const n = codeBlocks.length
      const lines = block.text.split('\n').length
      return `[code${total > 1 ? ` ${n} of ${total}` : ''} - ${lines} lines - tap to view]`
    })
    .join('\n\n')
}

function layoutBlock(block: number): Omit<CodeView, 'screen'> {
  const metrics = codeMetrics(CODE_FONT_PX)
  const screens = codeScreens(layoutCode(codeBlocks[block], metrics.cols), metrics.rows)
  return { block, screens, metrics }
}

function viewBlock(block: number, screen: number): void {
  const layout = layoutBlock(block)
  codeView = { ...layout, screen: Math.min(screen, layout.screens.length - 1) }
}

// Drawing a screen of code took about 4 s on the phone (G2-91), and every
// open drew it again. Screens are kept once drawn - keyed by everything
// that changes the picture, so a new answer or size never shows a stale
// one - and drawn ahead: the first screen when an answer with code
// arrives, the next one while the wearer reads.
const TILE_CACHE_MAX = 24
const tileCache = new Map<string, Promise<Uint8Array[]>>()

function footerFor(view: Omit<CodeView, 'screen'>, screen: number): string {
  const lines = view.screens[screen]
  const first = view.screens.slice(0, screen).reduce((n, s) => n + s.length - 1, 0) + 1
  const total = view.screens.reduce((n, s) => n + s.length, 0) - (view.screens.length - 1)
  const where = codeBlocks.length > 1 ? `Code ${view.block + 1}/${codeBlocks.length} - ` : ''
  const more = screen < view.screens.length - 1 ? 'swipe for more, ' : ''
  return `${where}lines ${first}-${first + lines.length - 1} of ${total} - ${more}hold: ask, double-tap: text`
}

function tilesFor(view: Omit<CodeView, 'screen'>, screen: number): Promise<Uint8Array[]> {
  const footer = footerFor(view, screen)
  const key = [view.metrics.fontPx, view.metrics.withFont, footer, codeBlocks[view.block]].join('|')
  const known = tileCache.get(key)
  if (known) return known
  const drawn = renderCodeTiles(view.screens[screen], view.metrics, footer)
  drawn.catch(() => tileCache.delete(key))
  tileCache.set(key, drawn)
  if (tileCache.size > TILE_CACHE_MAX) {
    const oldest = tileCache.keys().next().value
    if (oldest !== undefined) tileCache.delete(oldest)
  }
  return drawn
}

// Draws the first screen of the first code block in the background, so a
// tap on "[code ...]" only has to send it.
let warmTimer: ReturnType<typeof setTimeout> | null = null
function warmCode(): void {
  if (warmTimer !== null) clearTimeout(warmTimer)
  warmTimer = setTimeout(() => {
    warmTimer = null
    if (codeBlocks.length === 0 || codeView) return
    void loadCodeFont().then(() => {
      if (codeBlocks.length > 0 && !codeView) void tilesFor(layoutBlock(0), 0).catch(() => {})
    })
  }, 300)
}

async function drawCode(): Promise<void> {
  if (drawing) {
    drawAgain = true
    return
  }
  // Measured before the bundled font arrived: measure again with it.
  const fontStarted = performance.now()
  await loadCodeFont()
  const fontMs = performance.now() - fontStarted
  if (codeView && !codeView.metrics.withFont && isCodeFontLoaded()) {
    viewBlock(codeView.block, codeView.screen)
  }
  drawing = true
  try {
    do {
      drawAgain = false
      const view = codeView
      if (!view) return
      const renderStarted = performance.now()
      const tiles = await tilesFor(view, view.screen)
      status(
        `Jarvis: code font ${(fontMs / 1000).toFixed(1)}s (${isCodeFontLoaded() ? 'bundled' : 'fallback'}), ready in ${((performance.now() - renderStarted) / 1000).toFixed(1)}s`,
      )
      const sendStarted = performance.now()
      await setTiles(tiles)
      if (openStartedAt !== null) {
        status(
          `Jarvis: code shown ${((performance.now() - openStartedAt) / 1000).toFixed(1)}s after the tap (sending ${((performance.now() - sendStarted) / 1000).toFixed(1)}s)`,
        )
        openStartedAt = null
      }
      // The next screen, while this one is read.
      if (view.screen + 1 < view.screens.length) {
        void tilesFor(view, view.screen + 1).catch(() => {})
      }
    } while (drawAgain && codeView)
  } finally {
    drawing = false
  }
}

let openStartedAt: number | null = null

function openCodeView(): void {
  if (codeBlocks.length === 0) return
  openStartedAt = performance.now()
  nextTileBank()
  viewBlock(0, 0)
  status(`Jarvis: code view (${codeView?.metrics.cols} x ${codeView?.metrics.rows})`)
  requestRebuild(chatTool, () => void drawCode())
}

// Forward or back one screen, moving on to the next block at the end.
function moveCode(delta: 1 | -1): void {
  const view = codeView
  if (!view) return
  const next = view.screen + delta
  if (next >= 0 && next < view.screens.length) {
    view.screen = next
  } else if (delta === 1 && view.block < codeBlocks.length - 1) {
    viewBlock(view.block + 1, 0)
  } else if (delta === -1 && view.block > 0) {
    viewBlock(view.block - 1, Number.MAX_SAFE_INTEGER)
  } else {
    return
  }
  void drawCode()
}

// Long press in the code view (G2-75): the next size, staying near the same
// place in the code. Saved, so the phone's setting follows.
function closeCodeView(): void {
  if (!codeView) return
  codeView = null
  requestRebuild(chatTool, fillSection)
}

const STATUS_FRAMES = ['.', '..', '...']
// Per direct request: update every second, showing elapsed time, not a
// faster cosmetic flicker - the counter itself is the "is this alive"
// signal now, the cycling dots are secondary.
const STATUS_TICK_MS = 1000

// A cycling ". .. ..." plus an elapsed-seconds counter, both just a fixed
// string on a setInterval - nothing running repeated model inference on
// the main thread (that is what made live captions unsafe, see the
// comment at this function's call sites). mySession is the same staleness
// token every other async step here already checks; the timer checks it
// too so a tick can never land after the session that started it has
// moved on.
//
// Only one of these may run at a time (Listening and Thinking are never
// both active together), but this guards that invariant defensively
// anyway rather than trusting every call site to get it right: starting a
// new one always stops whatever the last one left running first. A
// leaked interval here would not just look wrong on screen - it is a real
// background cost (a setContent/bridge call every tick, forever) that
// could add up across a long session.
let stopActiveStatus: (() => void) | null = null

function startLiveStatus(
  mySession: number,
  render: (dots: string, elapsedSeconds: number) => void,
  startedAt = Date.now(),
): () => void {
  stopActiveStatus?.()
  let frame = 0
  const tick = () => {
    if (mySession !== sessionToken) {
      stop()
      return
    }
    render(STATUS_FRAMES[frame], Math.floor((Date.now() - startedAt) / 1000))
    frame = (frame + 1) % STATUS_FRAMES.length
  }
  tick()
  const interval = setInterval(tick, STATUS_TICK_MS)
  const stop = () => {
    clearInterval(interval)
    if (stopActiveStatus === stop) stopActiveStatus = null
  }
  stopActiveStatus = stop
  return stop
}

// When the current recording started, so "Transcribing" can say how much
// speech it is working through (see finishListening).
let listeningStartedAt = 0

// "New chat" was just picked, so recording starts as soon as its page is
// on screen (see onContentReady).
let listenWhenReady = false

// Set when a recording is cut off by the app being sent to the background
// (see stopListeningIfAny), so the wearer is told on return instead of
// facing a frozen "Listening" screen that no longer responds to a tap.
let interrupted = false

// The question a Gemini request is currently in flight for, if any - so a
// return from the background can put the "Thinking" counter back up (see
// onResume), since going to the background stops it.
let inFlightQuestion: string | null = null
// ...and the conversation it was asked in, so neither the "busy" check nor
// a return from the background mixes it up with a different conversation
// opened since.
let inFlightSessionId: string | null = null

function waitingHere(): boolean {
  return inFlightQuestion !== null && inFlightSessionId === currentSessionId
}

// Which Gemini request inFlightQuestion and the Thinking counter belong to.
// The wearer can leave a conversation while it is still thinking and start
// a new one; when the OLD reply finally lands it must not clear the new
// conversation's state or stop its status display - it used to stop
// whatever status was showing, freezing a new recording's Listening counter.
let currentAskId = 0
let stopThinking: (() => void) | null = null

// Between the tap that ends a recording and its transcript arriving. A
// long-press then used to start a second recording on top of the first's
// transcription.
let transcribing = false

// Recording, transcribing, or waiting on Gemini: a long-press asking the
// next question waits until this one is done.
// Between the transcript and the request going out (checking for a
// command, reading the AI settings) Jarvis is busy too (G2-86): a phone
// navigation in that gap switched the glasses to the chat list, and the
// question was then dropped as no longer on screen. A count, because
// finishListening's span contains askGemini's.
let preparing = 0

function busy(): boolean {
  return listening || transcribing || preparing > 0 || waitingHere()
}

// Set by the shell just before "Hey Jarvis" opens or continues a
// conversation (G2-64), consumed by the next beginListening: that
// recording starts from the audio just before the wake word, ends by
// itself when the wearer stops talking, and drops "Hey Jarvis" from the
// transcript. A long-press recording is unchanged and ends on a tap.
let nextListenViaWake = false

export function armWakeListen(): void {
  nextListenViaWake = true
}

// For the shell's "may Hey Jarvis start something now" check: never on top
// of a recording, a transcription or a question still being answered.
export function isBusy(): boolean {
  return busy()
}

async function beginListening() {
  codeView = null
  const mySession = ++sessionToken
  const viaWake = nextListenViaWake
  nextListenViaWake = false
  listening = true
  interrupted = false
  // A new recording means a new question, not a retry of the old one -
  // once the wearer starts speaking again, whatever failed before is no
  // longer what a tap should resend.
  lastErrorQuestion = null
  pages = []
  const ok = await start(
    () => {
      if (mySession !== sessionToken) return
      finishListening()
    },
    viaWake
      ? {
          preroll: takePreroll(),
          stripWake: true,
          // Every ending is transcribed, "no-speech" included: the loudness
          // check misses quiet speech [LAB-SIM: speaker-to-mic speech at
          // 2.5x the room level], and a command said in one breath with
          // "Hey Jarvis" sits in the preroll it never looks at. Whisper is
          // the real judge; with nothing but "Hey Jarvis" it fails as
          // 'heard only "Hey Jarvis"'.
          onEndpoint: () => {
            if (mySession !== sessionToken || !listening) return
            void finishListening()
          },
        }
      : {},
  )
  if (mySession !== sessionToken) return
  if (!ok) {
    listening = false
    setContent('Could not start the glasses microphone.\n\nLong-press to try again.')
    return
  }
  listeningStartedAt = Date.now()
  // Status-line breadcrumbs through the whole voice flow (here, on a tap,
  // on an interruption), so a report of "stuck" says exactly which step
  // it stopped at - see the companion page's status line.
  status(viaWake ? 'Jarvis: recording (Hey Jarvis)' : 'Jarvis: recording')
  const hint = viaWake ? '(stops when you do, or tap)' : '(tap when done)'
  startLiveStatus(mySession, (dots, elapsedSeconds) => {
    setContent(`Listening${dots} (${elapsedSeconds}s)\n\n${hint}`)
  })
}

// Sends currentMessages (already ending with the question to answer - see
// the two callers below) to Gemini and renders whatever comes back. Shared
// by finishListening (a fresh question, just appended) and retry (the same
// failed question, already sitting at the end of currentMessages from the
// first attempt - NOT re-appended, that would duplicate it in history).
// question is passed separately only for what to show while waiting and on
// a repeat failure; the actual request body is currentMessages itself.
// The "Thinking" display, as its own function so onResume can put it back
// after a trip to the background stopped it. Elapsed time counts from when
// the request started, not from the restart.
let thinkingStartedAt = 0
let thinkingRetryNote = ''

// How often a streaming answer may redraw the glasses. Each redraw is a
// Bluetooth update; a few per second reads as live without flooding it.
const STREAM_DRAW_MS = 300

function showThinking(): void {
  stopThinking = startLiveStatus(
    sessionToken,
    (dots, elapsedSeconds) => {
      setContent(`Thinking${dots} (${elapsedSeconds}s)${thinkingRetryNote}`)
    },
    thinkingStartedAt,
  )
}

async function askGemini(question: string) {
  preparing++
  try {
    await askGeminiNow(question)
  } finally {
    preparing--
  }
}

async function askGeminiNow(question: string) {
  // What "this is still relevant" actually means for rendering a network
  // response, as opposed to mySession/sessionToken, which exists to stop
  // overlapping VOICE CAPTURE lifecycles (a double-start), not to gate a
  // late-arriving fetch. Conflating the two was a real bug [HW]: the
  // answer was saved but the screen kept showing a stale error, and
  // reopening the conversation showed the real answer. The conversation
  // this question belongs to is captured now - id, title and messages -
  // so the answer is filed against it even if the wearer has moved on by
  // the time it arrives.
  const targetSessionId = currentSessionId
  const targetTitle = currentSessionTitle
  const messagesAtAsk = currentMessages
  if (targetSessionId === null) return
  const stillRelevant = () => depth === 'conversation' && currentSessionId === targetSessionId

  // Whichever AI the wearer chose on the companion page (G2-68).
  status('Jarvis: loading AI settings')
  const llm = await getLlmConfig('glasses')
  // Not the voice-capture session token - see finishListening for how that
  // silently dropped questions on a brief trip to the background.
  if (!stillRelevant()) {
    status('Jarvis: question not sent - its chat is no longer on screen')
    return
  }
  if (!llm) {
    status('Jarvis: no AI key for questions on the glasses')
    setContent(
      'No AI key set up yet - Jarvis needs one to answer questions.\n\n' +
        'Add one in Jarvis on the companion page, then try again.',
    )
    return
  }

  // Shows the question immediately, before Gemini has answered, with
  // elapsed time - safe to animate, unlike live captions (see the Jarvis
  // history this session): a fixed string on a timer, not Whisper running
  // on the main thread. thinkingRetryNote is set by converse()'s onRetry
  // callback below, so automatic retries show up on screen instead of
  // looking like a hang.
  pages = []
  const myAsk = ++currentAskId
  thinkingStartedAt = Date.now()
  thinkingRetryNote = ''
  inFlightQuestion = question
  inFlightSessionId = targetSessionId
  status('Jarvis: asking')
  showThinking()

  let attemptsMade = 1
  // Streamed answer text fills the first page as it arrives (G2-62), so
  // the wearer starts reading after the first words instead of after the
  // whole reply. Only page 1, and only when it actually changed: every
  // content update resets scroll, so once page 1 is full it is left alone,
  // and a wearer who has scrolled is never yanked back to the top. The
  // finished answer then replaces this with the normal paged view below.
  const streamStartedAt = Date.now()
  let streamedPage = ''
  let lastStreamDrawAt = 0
  const onText = (textSoFar: string) => {
    if (myAsk !== currentAskId || !stillRelevant()) return
    if (lastScrollAt > streamStartedAt) return
    const now = Date.now()
    if (now - lastStreamDrawAt < STREAM_DRAW_MS) return
    const firstPage = paginate(textSoFar, PAGE_INNER_WIDTH)[0]?.text
    if (!firstPage || firstPage === streamedPage) return
    stopThinking?.()
    stopThinking = null
    streamedPage = firstPage
    lastStreamDrawAt = now
    setContent(firstPage)
  }
  status(`Jarvis: asking ${describeModel(llm)}`)
  // The request itself is shared with the phone (assistant.ts, G2-70).
  const reply = await askAssistant(llm, messagesAtAsk, targetSessionId, {
    onText,
    onRetry: (attempt, max) => {
      attemptsMade = attempt
      if (myAsk === currentAskId) thinkingRetryNote = `\nRetrying (${attempt}/${max})...`
    },
  })
  // Only if this is still the latest request - see currentAskId.
  if (myAsk === currentAskId) {
    inFlightQuestion = null
    inFlightSessionId = null
    stopThinking?.()
    stopThinking = null
  }
  status(
    reply.kind === 'error'
      ? `Jarvis: failed (${reply.message})`
      : reply.kind === 'actions'
        ? `Jarvis: doing ${reply.calls.map(c => c.name).join(', ')}`
        : 'Jarvis: answered',
  )

  if (reply.kind === 'error') {
    if (!stillRelevant()) return
    lastErrorQuestion = question
    const triedNote = attemptsMade > 1 ? ` after ${attemptsMade} tries` : ''
    setContent(
      `You: ${shortQuestion(question)}${DIVIDER}Couldn't reach ${providerInfo(llm.provider).label}${triedNote} (${reply.message}).` +
        '\n\n(tap to retry, double-tap to go back)',
    )
    return
  }

  // An action is carried out whether or not the wearer is still looking -
  // they asked for it, same as an answer is saved regardless (below). Its
  // reply is the actions' own confirmation, never the model's text.
  const replyText = reply.kind === 'actions' ? await runAssistantActions(reply.calls) : reply.text
  // Correctness, not a render decision - a retry would be pointless and
  // wrong for a question that just got handled.
  if (lastErrorQuestion === question) lastErrorQuestion = null
  const answer: ChatMessage = {
    role: 'model',
    text: replyText,
    timestamp: Date.now(),
    ...(reply.kind === 'answer' && reply.sources ? { sources: reply.sources } : {}),
    ...(reply.kind === 'answer'
      ? { model: modelLabel(llm.provider, reply.model ?? llm.model) }
      : {}),
  }

  // An action as the very first thing said is a command from a blank
  // start, so it is not kept as a conversation - same rule as a local
  // command (see finishListening), so "add eggs to shopping" does not leave
  // a one-line chat behind. finishListening already saved the new session
  // holding just the question; it is taken back out here.
  if (reply.kind === 'actions' && messagesAtAsk.length === 1) {
    void chatSessions.remove(targetSessionId)
    if (!stillRelevant()) return
    currentSessionId = null
    currentSessionTitle = null
    currentMessages = []
    showCommandResult(messagesAtAsk[0], answer)
    publishScreen()
    return
  }

  // Saved regardless of stillRelevant() - the answer belongs to
  // targetSessionId's own history whether or not the wearer is still
  // looking at it, and has to be there the next time it is opened. In the
  // background: nothing about showing the answer waits on storage.
  const answeredMessages = [...messagesAtAsk, answer]
  void chatSessions.save({
    id: targetSessionId,
    title: targetTitle ?? '(untitled)',
    messages: answeredMessages,
    updatedAt: Date.now(),
  })
  if (!stillRelevant()) return
  currentMessages = answeredMessages
  setContent(renderConversation())
  publishScreen()
}

// A command's result from a blank start: shown, not saved. Long-pressed
// from another screen, the wearer is then handed back, as long as they
// have not started something else in the meantime.
function showCommandResult(question: ChatMessage, reply: ChatMessage): void {
  setContent(renderExchange([question, reply]))
  if (!quickAsk) return
  setTimeout(() => {
    if (!quickAsk || depth !== 'conversation' || currentSessionId !== null) return
    if (busy()) return
    returnHandler?.()
  }, COMMAND_RETURN_DELAY_MS)
}

// Ends the current recording, transcribes it, and sends the WHOLE
// conversation so far plus the new question to Gemini in one request -
// Gemini has no memory of its own between calls, so every prior exchange
// has to be resent each time for a follow-up to actually be a follow-up.
// Exported so the shell can call it directly on a tap while this tool's
// conversation screen is actively listening (see app/main.ts) - same shape
// as Jarvis's own exported finishListening, just a different gesture.
export async function finishListening() {
  listening = false
  const sessionIdBeforeAsking = currentSessionId
  // Stop the Listening counter now, not whenever the next startLiveStatus
  // call happens to land - otherwise it keeps ticking (and overwriting
  // the screen) all through transcription, and would overwrite the
  // "Didn't catch that" error below entirely, since nothing else would
  // ever stop it on that path.
  stopActiveStatus?.()
  // A fixed message, not a ticking counter: transcription runs Whisper on
  // the same main thread the counter's timer needs, so the counter could
  // never move [HW - it sat at 0s the whole time]. The length of what was
  // recorded is real, and it tells the wearer roughly how long to expect.
  const recordedSeconds = Math.max(1, Math.round((Date.now() - listeningStartedAt) / 1000))
  status(`Jarvis: transcribing ${recordedSeconds}s of audio`)
  setContent(`Transcribing ${recordedSeconds}s of speech...\n\n(this can take a moment)`)
  transcribing = true
  const result = await stop()
  transcribing = false
  // Dropped only if the wearer actually moved on - left this conversation,
  // or started a new recording. The old check here was the voice-capture
  // session token, which a brief app-in-background blip also bumps: a
  // question that finished transcribing during one was silently thrown
  // away, leaving "Transcribing" on screen for good.
  if (depth !== 'conversation' || currentSessionId !== sessionIdBeforeAsking || listening) {
    status('Jarvis: question dropped - conversation changed while transcribing')
    return
  }

  if (result.kind === 'error') {
    status(`Jarvis: transcription failed (${result.message}), via ${engineDescription()}`)
    setContent(`Didn't catch that (${result.message}).\n\nLong-press to try again.`)
    return
  }

  const question: ChatMessage = { role: 'user', text: result.transcript, timestamp: Date.now() }
  status(
    `Jarvis: heard ${result.transcript.length} chars, audio level ${result.peak.toFixed(3)}, ${result.audioSeconds.toFixed(1)}s of audio in ${(result.transcribeMs / 1000).toFixed(1)}s via ${engineDescription()}${result.levels === null ? '' : `, room ${result.levels.floor.toFixed(4)} loudest ${result.levels.loudest.toFixed(4)}`}`,
  )

  // Commands first, locally - a timer needs no network, no API key, and no
  // Gemini round trip (see the voice dispatch registered in app/main.ts).
  // Anything that is not a command falls through to Gemini below.
  preparing++
  try {
    status('Jarvis: checking for a command')
    const command = await dispatchVoiceCommand(result.transcript)
    if (command.handled) {
      if (depth !== 'conversation' || currentSessionId !== sessionIdBeforeAsking || listening)
        return
      const reply: ChatMessage = { role: 'model', text: command.message, timestamp: Date.now() }
      status('Jarvis: ran a command')
      if (currentSessionId === null) {
        // A command from a blank start is not saved as a conversation -
        // timers would otherwise fill the history with one-line chats.
        showCommandResult(question, reply)
        return
      }
      // Mid-conversation, the command is part of it like anything else said.
      currentMessages = [...currentMessages, question, reply]
      saveCurrent()
      setContent(renderConversation())
      return
    }
    if (depth !== 'conversation' || currentSessionId !== sessionIdBeforeAsking || listening) {
      status('Jarvis: question dropped - the screen changed before asking')
      return
    }

    // Added in memory right away, no await - the old version awaited a
    // storage write here before asking Gemini, which is exactly the kind of
    // wait a slow or stuck host read turned into a frozen screen.
    if (currentSessionId === null) {
      const created = chatSessions.newSession(question)
      currentSessionId = created.id
      currentSessionTitle = created.title
      currentMessages = created.messages
    } else {
      currentMessages = [...currentMessages, question]
    }
    saveCurrent()
    // "New chat" only gets a real id once this first question exists -
    // publish now so the companion page can follow to the right session.
    publishScreen()

    await askGemini(result.transcript)
  } finally {
    preparing--
  }
}

// Tries the SAME question again with no new recording, triggered by a
// single tap on the Gemini-error screen (see app/main.ts's isSingleTap
// carve-out) - per direct request, re-speaking a question just to hit the
// same network error again is the wrong recovery path. currentMessages
// already ends with the unanswered question from the first attempt (see
// finishListening above), so this calls askGemini directly rather than
// going through finishListening - appending the question again would
// duplicate it in history.
export async function retry() {
  // A second tap while the first retry is still waiting on Gemini would
  // otherwise send the same question twice.
  if (lastErrorQuestion === null || waitingHere()) return
  const question = lastErrorQuestion
  await askGemini(question)
}

function stopListeningIfAny() {
  sessionToken++
  // Unconditional, not just while listening - this also runs on
  // close/suspend while waiting on Gemini (Thinking), and a leaked
  // interval still ticking against a container that is being torn down
  // is worth killing immediately rather than waiting up to a second for
  // its own staleness check to catch up.
  stopActiveStatus?.()
  if (listening) {
    listening = false
    cancel()
    // The recording is gone, but the screen still says "Listening" and a
    // tap no longer does anything - a dead end, unless onResume tells the
    // wearer what happened (see below).
    interrupted = true
    status('Jarvis: recording stopped before it was finished')
  }
}

// Back from the background (or the system menu, which reports the same
// way - docs/platform.md, Contextual menu). Puts back whatever going to the
// background stopped: an interrupted recording becomes a clear message,
// and a question still waiting on Gemini gets its "Thinking" counter back.
function resume(): void {
  if (depth !== 'conversation') return
  if (codeView) {
    void drawCode()
    return
  }
  if (interrupted) {
    interrupted = false
    pages = []
    setContent('Recording was interrupted.\n\nLong-press to ask again.')
    return
  }
  if (inFlightQuestion !== null && waitingHere() && stopActiveStatus === null) {
    showThinking()
  }
}

// Starts recording if this page was opened to do so (a long-press, or "New
// chat") - once the page is actually on screen, since the Listening
// counter needs its text container to exist. Called from both onOpen (the
// shell opening this tool) and onContentReady (a rebuild after picking a
// row in the list).
function startIfPending(): void {
  if (!listenWhenReady) return
  listenWhenReady = false
  if (depth === 'conversation' && !listening) void beginListening()
}

// A conversation changed outside this screen (G2-70) - asked or deleted on
// the phone. Redraws only when what the glasses show would differ: its own
// saves match what is already on screen, and nothing is touched while a
// question is being recorded, transcribed or answered here. The shell
// ignores the rebuild unless Jarvis is the page on screen.
chatSessions.onChange(() => {
  // Not under the code view: it shows the answer already on screen.
  if (codeView) return
  const sessions = chatSessions.peek() ?? []
  if (depth === 'picker') {
    pickerSessions = sortForPicker(sessions)
    requestRebuild(chatTool, fillSection)
    return
  }
  if (currentSessionId === null || busy()) return
  const session = sessions.find(s => s.id === currentSessionId)
  if (!session) {
    showSession(null)
    requestRebuild(chatTool, fillSection)
    publishScreen()
    return
  }
  const last = (messages: readonly ChatMessage[]) => messages[messages.length - 1]?.timestamp
  if (
    session.messages.length === currentMessages.length &&
    last(session.messages) === last(currentMessages)
  ) {
    return
  }
  currentMessages = session.messages
  currentSessionTitle = session.title
  pages = []
  requestRebuild(chatTool, fillSection)
})

// After a rebuild showed only rebuildSafe's start of a long section, put
// the whole section up.
function fillSection(): void {
  if (codeView) {
    void drawCode()
    return
  }
  if (depth !== 'conversation' || pages.length === 0 || listening) return
  const full = pages[pageIndex].text
  if (full !== rebuildSafe(full)) setContent(full)
}

export const chatTool: Tool = {
  name: 'Jarvis',
  // Always, in both the picker and a conversation, per direct request to
  // follow the same convention Teleprompter already settled on: an
  // accidental double-tap should be double-checked no matter which screen
  // it happens on, regardless of whether anything would actually be lost.
  confirmOnExit: () => true,
  // Matches onConfirmedExit's own logic exactly, same reasoning as
  // Teleprompter's own pair of these two: one describes what pressing Yes
  // says, the other is what it does.
  confirmPrompt: () =>
    depth === 'conversation' && !quickAsk ? 'Leave this conversation?' : 'Leave Jarvis?',
  beforeOpen: refresh,
  contentKind: () => (depth === 'picker' ? 'list' : codeView ? 'tiles' : 'text'),
  listItems: () => ['New chat', ...pickerSessions.map(s => pickerTitle(s.title))],
  onListSelect: index => {
    if (depth !== 'picker') return
    listenWhenReady = index === 0
    if (index === 0) {
      currentSessionId = null
      currentMessages = []
      currentSessionTitle = null
    } else {
      const picked = pickerSessions[index - 1]
      if (!picked) return
      currentSessionId = picked.id
      currentMessages = picked.messages
      currentSessionTitle = picked.title
    }
    depth = 'conversation'
    quickAsk = false
    lastErrorQuestion = null
    interrupted = false
    pages = []
    publishScreen()
  },
  // Re-asserts this tool's own detail after the shell's generic baseline
  // publish (see app/main.ts's setCurrentScreen calls in openTool/restore,
  // both of which call onOpen AFTER that baseline), then starts recording
  // if this open was a long-press.
  onOpen: () => {
    publishScreen()
    fillSection()
    startIfPending()
  },
  // After the rebuild from picking a row in the list: "New chat" goes
  // straight to recording - per direct request, there is nothing else to do
  // on an empty conversation, so a long-press first was a wasted step.
  onContentReady: () => {
    fillSection()
    startIfPending()
  },
  // Inside a conversation: ask the next question. (On the list, the shell
  // handles a long-press itself, by opening a new conversation - see
  // app/main.ts.)
  onLongPress: () => {
    if (codeView) {
      // Ask the next question, same as from the text (G2-93: one code
      // size, so long press no longer resizes) - back to the text page
      // first, then record.
      codeView = null
      requestRebuild(chatTool, () => {
        if (depth === 'conversation' && !busy()) void beginListening()
      })
      return
    }
    // Not while this conversation is still recording, transcribing or
    // waiting on Gemini - see busy().
    if (depth !== 'conversation' || busy()) return
    void beginListening()
  },
  // Confirming "leave" backs up exactly one level, matching what "back"
  // means everywhere else in this app and exactly mirroring Teleprompter's
  // own onConfirmedExit: from a conversation, Yes steps back to the list;
  // from the list, Yes leaves Jarvis. A conversation started by a
  // long-press from another screen is the exception: Yes leaves Jarvis
  // entirely, and the shell takes the wearer back to where they
  // long-pressed from (see app/main.ts's confirmExit). Stops a recording in
  // progress if there was one, and syncs the list so it reflects whatever
  // was just said (see syncPickerFromCurrent above).
  onConfirmedExit: () => {
    if (depth !== 'conversation' || quickAsk) return 'menu'
    stopListeningIfAny()
    syncPickerFromCurrent()
    depth = 'picker'
    currentSessionId = null
    currentMessages = []
    currentSessionTitle = null
    lastErrorQuestion = null
    pages = []
    publishScreen()
    return 'tool'
  },
  onClose: () => {
    codeView = null
    stopListeningIfAny()
  },
  onTap: () => {
    if (depth !== 'conversation' || busy()) return
    if (codeView) moveCode(1)
    else openCodeView()
  },
  onBack: () => {
    if (!codeView) return false
    closeCodeView()
    return true
  },
  screenDetail,
  // The companion asking for the list or a saved conversation (G2-69).
  // Never on top of a recording, transcription or answer in progress -
  // switching would lose the question; the glasses stay put, and the
  // companion follows them back.
  showDetail: (detail, isOpen) => {
    const wanted = isChatDetail(detail) && detail.depth === 'conversation' ? detail.sessionId : null
    if (!isOpen) {
      openSessionId = wanted
      return false
    }
    if (busy()) {
      status('Jarvis: phone asked for another screen - ignored while answering')
      return false
    }
    if (wanted === currentSessionId && (wanted !== null || depth === 'picker')) return false
    status(`Jarvis: phone opened ${wanted === null ? 'the chat list' : 'a chat'}`)
    syncPickerFromCurrent()
    showSession(wanted)
    return true
  },
  onSuspend: stopListeningIfAny,
  onResume: resume,
  // Called only for a swipe at a page's top (-1) or bottom (1) edge - the
  // firmware handles scrolling within a page itself. Turns the page per the
  // arm-then-turn rule above. Ignored while anything other than the
  // conversation is on screen - recording, transcribing, thinking - which
  // is exactly when pages is empty or a live status is running.
  onScroll: delta => {
    if (codeView) {
      moveCode(delta)
      return
    }
    if (depth !== 'conversation' || listening || stopActiveStatus !== null) return
    if (pages.length <= 1) return
    const now = Date.now()
    if (now - lastScrollAt < SCROLL_COOLDOWN_MS) return
    lastScrollAt = now
    const next = Math.min(Math.max(pageIndex + delta, 0), pages.length - 1)
    if (next === pageIndex) return
    // The firmware only reports a swipe at a section's very top or bottom,
    // so one swipe there moves on - no second "are you sure" swipe.
    pageIndex = next
    // Any content update starts the new page at its top - including when
    // going back, so a previous page is re-read from its start.
    setContent(pages[pageIndex].text)
  },
  // Never actually rendered for the picker (contentKind is 'list' there).
  // For a conversation: the page already being read, if any - so "No" on the
  // leave prompt, which rebuilds this same page, puts the wearer back on it
  // rather than at the start of the answer. Otherwise the first page of the
  // latest exchange. Every page is under the firmware's 1000-character
  // ceiling for a rebuild (features/chat/paging.ts's PAGE_MAX_CHARS).
  // A rebuild carries at most 1000 characters; a longer section shows its
  // start, and onContentReady fills in the rest.
  initialContent: () =>
    rebuildSafe(pages.length > 0 ? pages[pageIndex].text : renderConversation()),
}
