import { getCodeSize } from '../../core/codeSize'
import { setStatusNote } from '../../core/statusNote'
import { MODES, modeOf, type ModeId } from '../../core/modes'
import { positionLabel } from '../../shared/position'
import { exchangesOf, historyRows } from './exchanges'
import { questionLine } from '../../shared/questionKeywords'
import { modelLabel } from '../../core/llmProviders'
import { cancel, isLiveTranscribing, start, stop } from '../../core/voiceCapture'
import { engineDescription } from '../../core/whisper'
import { takePreroll } from '../../core/wakeListener'
import { dispatchVoiceCommand } from '../../core/voiceDispatch'
import { runAssistantActions } from '../../core/assistantActions'
import { describeModel } from '../../core/llm'
import { getLlmConfig, providerInfo } from '../../core/llmSettings'
import { chatSessions, type ChatMessage, type ChatSession } from './store'
import { setContent } from '../../platform/page'
import { status } from '../../platform/bridge'
import { TYPING_CHARS_PER_SECOND, TYPING_TICK_MS, nextShown } from './typing'
import {
  moveView,
  movePaged,
  pageIndexAt,
  rowsOf,
  tailWin,
  viewLabel,
  viewPages,
  windowText,
  type Win,
} from './viewer'
import {
  PAGE_INNER_WIDTH,
  SCREEN_ROWS,
  wrapLines,
  REBUILD_MAX_CHARS,
  fitsAsText,
  lowerPageLimit,
  paginate,
  rebuildSafe,
  tailRows,
  type Page,
} from './paging'
import { splitAnswer } from '../../shared/answerBlocks'
import { codeScreens, layoutCodeRows, type CodeRow } from '../../shared/codeLayout'
import { codeGutter, codeMetrics, renderCodeTiles, type CodeMetrics } from '../../ui/codeRender'
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
// 'history' (G2-102) is the list of one conversation's exchanges, between
// the chat list and one exchange: double-tap steps back one level at a time,
// code > question and answer > exchanges > chats > launcher.
type Depth = 'picker' | 'history' | 'conversation'
let depth: Depth = 'picker'

// Which exchange the question-and-answer screen shows; null is the latest.
// Tied to how many exchanges there were when it was chosen, so a new
// question or answer always brings the latest back.
let focus: { index: number; of: number } | null = null

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
// Dev only (companion/devControl.ts, never reached in a build): asks a
// question on the glasses as if it had just been spoken and transcribed, so
// the typing view can be tested without a microphone. Jarvis must be open.
export async function devAsk(text: string): Promise<void> {
  const created = chatSessions.newSession({ role: 'user', text, timestamp: Date.now() })
  depth = 'conversation'
  focus = null
  codeView = null
  pages = []
  quickAsk = false
  currentSessionId = created.id
  currentSessionTitle = created.title
  currentMessages = created.messages
  // Saved before it is announced: the phone page looks the chat up, and
  // sends the glasses back to the list if it is not there yet.
  await chatSessions.save({
    id: created.id,
    title: created.title,
    messages: created.messages,
    updatedAt: Date.now(),
  })
  publishScreen()
  requestRebuild(chatTool, () => void askGemini(text))
}

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
  updatePositionNote()
}

// Puts a page of text on the glasses. If the update is rejected because it
// is long (see lowerPageLimit), the sections get shorter and the same view
// is drawn again in them - redo gives the new first page.
async function showPage(text: string, redo: () => string = renderConversation): Promise<void> {
  const ok = await setContent(text)
  if (ok || text.length <= REBUILD_MAX_CHARS || !lowerPageLimit()) return
  status('Jarvis: the glasses refused a long update - using shorter sections')
  await setContent(redo())
}

// The page a view starts on, worked out again after the page size shrank
// (see lowerPageLimit): what to draw instead of a page the glasses refused.
function redoView(rows: string[], at: number, setWin: (w: Win) => void): () => string {
  return () => {
    const pagesNow = viewPages(rows)
    const win = pagesNow[pageIndexAt(pagesNow, at)] ?? { start: 0, end: rows.length }
    setWin(win)
    return windowText(rows, win)
  }
}

// Where the wearer is in a long answer or in code, in the middle of the
// status bar in place of the weather (G2-102).
// Tells at a glance, on every page, that the answer has a code view (G2-122).
function withCodeTag(label: string | null): string | null {
  if (codeBlocks.length === 0 || codeView) return label
  return label ? `${label} - tap: code` : 'Tap: code'
}

function updatePositionNote(): void {
  if (stream && stream.timer !== null) {
    setStatusNote(streamNote(stream))
    return
  }
  if (tailView) {
    setStatusNote(withCodeTag(viewLabel(tailView.rows, tailView.win)))
    return
  }
  let note: string | null = null
  if (depth === 'conversation' && !listening && !transcribing && stopActiveStatus === null) {
    note = codeView
      ? positionLabel(codeView.screen, codeView.screens.length)
      : withCodeTag(positionLabel(pageIndex, pages.length))
  }
  setStatusNote(note)
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
  focus = null
  const session = id ? (chatSessions.peek() ?? []).find(s => s.id === id) : undefined
  pages = []
  lastErrorQuestion = null
  interrupted = false
  quickAsk = false
  listenWhenReady = false
  if (!session) {
    depth = 'picker'
    currentSessionId = null
    currentMode = 'auto'
    currentMessages = []
    currentSessionTitle = null
    pickerSessions = sortForPicker(chatSessions.peek() ?? [])
    return
  }
  depth = 'conversation'
  currentSessionId = session.id
  currentMessages = session.messages
  currentSessionTitle = session.title
  currentMode = modeOf(session.mode).id
}

// The chat's mode (G2-139, core/modes.ts): picked with "New chat: ..." in
// the list, kept with the chat, shown next to the model's name.
let currentMode: ModeId = 'auto'

function withModeTag(model: string): string {
  return currentMode === 'auto' ? model : `${modeOf(currentMode).label} - ${model}`
}
const NEW_CHAT_ROWS = MODES.map(m => (m.id === 'auto' ? 'New chat' : `New chat: ${m.label}`))

// List containers have a firmware hard limit of 20 items (docs/platform.md).
// "New chat" is always the first row, leaving 19 for saved sessions - after
// enough testing/real use to pass that count, listItems() returning more
// than 20 total made the firmware reject the rebuild outright, which looked
// like Chat silently refusing to open at all [HW], not like a list that
// needed trimming. Only the picker is capped; nothing is deleted, and the
// companion page's own chat-view (see companion/main.ts) has no such limit
// and still shows every session.
const PICKER_MAX_SESSIONS = 20 - MODES.length

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
  focus = null
  const mode = nextOpenMode
  nextOpenMode = 'picker'
  quickAsk = mode === 'quickAsk'
  // The chat list, or - for a long-press - straight into a new
  // conversation, recording as soon as its page is on screen (see
  // startIfPending).
  depth = mode === 'picker' ? 'picker' : 'conversation'
  listenWhenReady = mode !== 'picker'
  currentSessionId = null
  currentMode = 'auto'
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

// The question line above an answer (G2-100): short questions in full, long
// ones boiled down to their key words (shared/questionKeywords.ts), so it
// never takes more than a line or two of the screen.
function youLine(question: string): string {
  return `You: ${questionLine(question)}`
}

// The pages currently on screen, and which one is showing. Empty whenever
// something other than the conversation is on screen (listening, thinking,
// an error), so a swipe there does nothing.
let pages: Page[] = []
let pageIndex = 0
// The part of the page on screen when going back landed on its last screenful
// (null: the whole page). See movePaged.
let pageWin: Win | null = null

// Set while the screen still shows the typed last screenful of a finished
// answer (G2-107): when the typing caught up by itself nothing replaces it,
// so the wearer is not thrown back to the first line. A swipe then reads
// over the answer in windows (features/chat/viewer.ts), starting just above
// that screen.
let tailView: { rows: string[]; win: Win } | null = null

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
  tailView = null
  if (messages.length === 0) {
    pages = []
    // Shown for the moment between picking "New chat" and the microphone
    // starting (see startIfPending), rather than an instruction to
    // long-press that is about to be done for the wearer anyway.
    return listenWhenReady
      ? 'Starting the microphone...'
      : 'No messages yet.\n\nLong-press to ask something.'
  }
  const exchanges = exchangesOf(messages)
  const at =
    focus && focus.of === exchanges.length && messages === currentMessages
      ? focus.index
      : exchanges.length - 1
  const shown = exchanges[at]
  codeBlocks = []
  const parts = [
    ...(shown.question ? [youLine(shown.question.text)] : []),
    ...(shown.answer
      ? [
          `${shown.answer.model ? `${shown.answer.model}: ` : ''}${withCodePlaceholders(shown.answer.text)}`,
        ]
      : []),
  ]
  pages = paginate(parts.join(DIVIDER), PAGE_INNER_WIDTH)
  pageIndex = 0
  pageWin = null
  warmCode()
  return pages[0].text
}

// THE CODE VIEW (G2-73). The glasses' own text has one proportional font,
// which scrambles code, so code in an answer is drawn as pictures instead
// (ui/codeRender.ts) in a real monospace font, at the size chosen on the
// phone. In the text view tall code stays as text with a hint under it; a tap
// opens the code view, a swipe or tap pages through it, and a double-tap
// returns to the text.
let codeBlocks: string[] = []
type CodeView = {
  block: number
  screen: number
  screens: CodeRow[][]
  metrics: CodeMetrics
  // Pixels the line numbers take, with the gap after them (G2-117).
  gutterPx: number
}
let codeView: CodeView | null = null
let drawing = false
let drawAgain = false

function withCodePlaceholders(text: string): string {
  const blocks = splitAnswer(text)
  if (!blocks.some(b => b.kind === 'code')) return text
  const isPicture = (b: (typeof blocks)[number]) =>
    b.kind === 'code' && !fitsAsText(b.text, PAGE_INNER_WIDTH)
  const total = blocks.filter(isPicture).length
  return blocks
    .map(block => {
      // Code too tall for one screen stays in the text too (G2-121), with a
      // hint under it that a tap opens the picture view.
      if (!isPicture(block)) return block.text
      codeBlocks.push(block.text)
      const n = codeBlocks.length
      return `${block.text}\n[tap: view code${total > 1 ? ` ${n} of ${total}` : ''} as a picture]`
    })
    .join('\n\n')
}

function layoutBlock(block: number): Omit<CodeView, 'screen'> {
  const metrics = codeMetrics(getCodeSize())
  // The gutter holds the widest line number; the code gets what is left.
  const { gutterPx, maxPx } = codeGutter(codeBlocks[block].split('\n').length, metrics)
  const rows = layoutCodeRows(codeBlocks[block], maxPx, metrics.measure, metrics.cell)
  return { block, screens: codeScreens(rows, metrics.rows), metrics, gutterPx }
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
  // Source line numbers, as in the gutter: the first and the last that
  // start on this screen, of the block's whole count.
  const numbers = view.screens[screen].flatMap(r => (r.number === null ? [] : [r.number]))
  const first = numbers[0] ?? 1
  const last = numbers[numbers.length - 1] ?? first
  const total = codeBlocks[view.block].split('\n').length
  const where = codeBlocks.length > 1 ? `Code ${view.block + 1}/${codeBlocks.length} - ` : ''
  const more = screen < view.screens.length - 1 ? 'swipe for more, ' : ''
  return `${where}lines ${first}-${last} of ${total} - ${more}hold: ask, double-tap: text`
}

function tilesFor(view: Omit<CodeView, 'screen'>, screen: number): Promise<Uint8Array[]> {
  const footer = footerFor(view, screen)
  const key = [view.metrics.fontPx, footer, codeBlocks[view.block]].join('|')
  const known = tileCache.get(key)
  if (known) return known
  const drawn = renderCodeTiles(view.screens[screen], view.metrics, footer, view.gutterPx)
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
    if (codeBlocks.length > 0 && !codeView) void tilesFor(layoutBlock(0), 0).catch(() => {})
  }, 300)
}

async function drawCode(): Promise<void> {
  if (drawing) {
    drawAgain = true
    return
  }
  drawing = true
  try {
    do {
      drawAgain = false
      const view = codeView
      if (!view) return
      const loading = showCodeLoading
      if (loading) {
        showCodeLoading = false
        await setContent(CODE_LOADING_TEXT)
      }
      const renderStarted = performance.now()
      const tiles = await tilesFor(view, view.screen)
      status(`Jarvis: code ready in ${((performance.now() - renderStarted) / 1000).toFixed(1)}s`)
      const sendStarted = performance.now()
      await setTiles(tiles)
      if (loading) await setContent(' ')
      updatePositionNote()
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

// The glasses switch to the image layout before any picture arrives, which
// left the screen blank for a couple of seconds (G2-102): say what is
// happening until the last picture lands.
const CODE_LOADING_TEXT = '\n\n\n\n        Loading code...'
let showCodeLoading = false

function openCodeView(): void {
  if (codeBlocks.length === 0) return
  openStartedAt = performance.now()
  showCodeLoading = true
  nextTileBank()
  viewBlock(0, 0)
  updatePositionNote()
  status(`Jarvis: code view (${codeView?.screens.length} screens)`)
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
  updatePositionNote()
  requestRebuild(chatTool, fillSection)
}

// The conversation as a list of its exchanges, newest first; tapping one
// opens it (G2-102). Nothing to list: straight back to the chats.
function openHistory(): void {
  if (exchangesOf(currentMessages).length === 0) {
    leaveToPicker()
    return
  }
  depth = 'history'
  pages = []
  publishScreen()
  requestRebuild(chatTool)
}

function leaveToPicker(): void {
  syncPickerFromCurrent()
  depth = 'picker'
  currentSessionId = null
  currentMode = 'auto'
  currentMessages = []
  currentSessionTitle = null
  lastErrorQuestion = null
  pages = []
  focus = null
  publishScreen()
  requestRebuild(chatTool)
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
  return !canListenNow()
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
  heardSoFar = ''
  const ok = await start(
    () => {
      if (mySession !== sessionToken) return
      finishListening()
    },
    {
      // Live captions (G2-136): what Gemini Live has heard so far.
      onCaption: text => {
        if (mySession !== sessionToken || !listening) return
        heardSoFar = text
        drawListening()
      },
      // Every recording ends by itself after a smart pause (G2-149,
      // shared/endOfTurn.ts): short when the question sounds finished, long
      // when it trails off. A tap still sends at once. Every ending is
      // transcribed, "no-speech" included: the loudness check misses quiet
      // speech [LAB-SIM], and Whisper or Gemini Live is the real judge.
      onEndpoint: () => {
        if (mySession !== sessionToken || !listening) return
        void finishListening()
      },
      ...(viaWake ? { preroll: takePreroll(), stripWake: true } : {}),
    },
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
  const hint = '(pause to send, or tap)'
  startLiveStatus(mySession, (dots, elapsedSeconds) => {
    listenHeader = `Listening${dots} (${elapsedSeconds}s) ${hint}`
    drawListening(true)
  })
}

// The listening screen: the counter line, then the live captions (G2-136),
// only the last rows, so the newest words are always on screen and nothing
// needs scrolling.
let heardSoFar = ''
let listenHeader = ''
const CAPTION_MIN_GAP_MS = 300
let lastListenDraw = 0
let listenDrawTimer: ReturnType<typeof setTimeout> | null = null

function drawListening(now = false): void {
  const draw = () => {
    listenDrawTimer = null
    lastListenDraw = Date.now()
    if (!listening) return
    const rows = heardSoFar ? wrapLines(heardSoFar, PAGE_INNER_WIDTH).slice(-(SCREEN_ROWS - 2)) : []
    void setContent(rows.length > 0 ? `${listenHeader}\n\n${rows.join('\n')}` : listenHeader)
  }
  if (now) {
    if (listenDrawTimer !== null) clearTimeout(listenDrawTimer)
    draw()
    return
  }
  if (listenDrawTimer !== null) return
  listenDrawTimer = setTimeout(draw, Math.max(0, lastListenDraw + CAPTION_MIN_GAP_MS - Date.now()))
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

// THE ANSWER AS IT IS TYPED (G2-104, G2-106). A model writes far faster than
// anyone reads, and every content update sends the firmware's scroll back to
// the top, so a growing page both raced ahead of the wearer and undid their
// scrolling. Instead the answer is revealed at a readable pace
// (features/chat/typing.ts), as its last screenful - newest line at the
// bottom - which is one screen, so there is nothing to scroll or jump.
//   follow: the typed last screenful. Tap pauses; swipe up pauses and goes
//           back a window.
//   hold:   paused, free to read up and down over what has arrived so far
//           (see PAUSED below). Tap goes on typing.
type Stream = {
  header: string
  label: string
  received: string
  shown: number
  budget: number
  lastTickAt: number
  complete: boolean
  fast: boolean
  mode: 'follow' | 'hold'
  timer: ReturnType<typeof setInterval> | null
  drawn: string
  relevant: () => boolean
  release: (() => void) | null
  // The window being read while paused.
  win: Win | null
  // Set when the typing caught up with the model by itself; unset if it was
  // cut short (left, backgrounded).
  outcome?: 'caught-up'
  // The last update sent to the glasses: the next must wait for it, as two
  // content updates in flight at once can be rejected.
  pending: Promise<unknown>
}
let stream: Stream | null = null

// The wearer-facing hint in the middle of the status bar.
function streamNote(s: Stream): string | null {
  if (s.mode === 'hold') {
    const rows = allRows(s)
    const win = s.win ?? tailWin(rows)
    return viewLabel(rows, win) ?? 'Tap to continue'
  }
  return s.shown < s.received.length ? 'Tap to pause' : null
}

function drawStream(s: Stream): void {
  if (stream !== s) return
  if (s.mode === 'follow') {
    const tail = tailRows(s.received.slice(0, s.shown), PAGE_INNER_WIDTH)
    if (tail && tail !== s.drawn) {
      s.drawn = tail
      s.pending = s.pending.then(() => setContent(tail))
    }
  }
  setStatusNote(streamNote(s))
}

function tickStream(s: Stream): void {
  if (stream !== s) return
  if (!s.relevant()) {
    endStream(s)
    return
  }
  const now = Date.now()
  const elapsed = now - s.lastTickAt
  s.lastTickAt = now
  if (s.mode === 'follow') {
    // Only typing time counts: a pause must not store up time that is then
    // spent in one burst on resuming (G2-110).
    s.budget += (TYPING_CHARS_PER_SECOND * elapsed) / 1000
    const next = nextShown(s.received, s.shown, s.fast ? Infinity : s.budget, s.complete)
    if (next > s.shown) {
      s.budget = s.fast ? 0 : Math.max(0, s.budget - (next - s.shown))
      s.shown = next
    }
    drawStream(s)
    if (s.complete && s.shown >= s.received.length) {
      s.outcome = 'caught-up'
      s.release?.()
    }
  } else {
    drawStream(s)
  }
}

function endStream(s: Stream): void {
  if (s.timer !== null) clearInterval(s.timer)
  s.timer = null
  s.release?.()
  s.release = null
  if (stream === s) {
    stream = null
    updatePositionNote()
  }
}

// The model has finished: wait until the typing has caught up, or - if the
// wearer stopped following - until they tap.
function waitForReveal(s: Stream): Promise<void> {
  return new Promise<void>(resolve => {
    s.release = resolve
    tickStream(s)
  }).then(() => s.pending.then(() => undefined))
}

// PAUSED (G2-107): a tap while the answer is being typed leaves the screen
// exactly as it is. The wearer then reads freely over everything that has
// arrived so far, in windows (features/chat/viewer.ts): smooth scrolling
// inside a window, a swipe past its edge moves to the next or previous one,
// and a swipe down past the last window waits for more to arrive. Tap again
// to go on typing from where they have read to.
function allRows(s: Stream): string[] {
  return rowsOf(s.received, PAGE_INNER_WIDTH)
}

function freezeStream(): Stream | null {
  const s = stream
  if (!s || s.timer === null || s.mode !== 'follow') return null
  s.mode = 'hold'
  s.win = tailWin(rowsOf(s.received.slice(0, s.shown), PAGE_INNER_WIDTH))
  setStatusNote(streamNote(s))
  return s
}

function moveHold(s: Stream, delta: -1 | 1): void {
  const now = Date.now()
  if (now - lastScrollAt < SCROLL_COOLDOWN_MS) return
  lastScrollAt = now
  const rows = allRows(s)
  const next = moveView(rows, s.win ?? tailWin(rows), delta)
  if (!next) {
    // Down past the last line: go on to the end at full speed (G2-111).
    if (delta === 1) skipToEnd(s)
    return
  }
  s.win = next
  const text = windowText(rows, next)
  const again = redoView(rows, next.start, w => (s.win = w))
  s.pending = s.pending.then(() => showPage(text, again))
}

function resumeStream(s: Stream): void {
  // Carries on from exactly where the typing paused (G2-110), not from where
  // the wearer scrolled to: reading ahead is allowed, but the typing must not
  // jump to the latest words.
  s.mode = 'follow'
  s.win = null
  s.drawn = ''
  s.budget = 0
  s.lastTickAt = Date.now()
  pages = []
  tickStream(s)
}

// Jump to the end of the answer at full speed (G2-111): a swipe down while
// it is typing, or down past the last line while paused. The screen then
// stays on the last lines, as when the typing finishes by itself.
function skipToEnd(s: Stream): void {
  s.fast = true
  if (s.mode === 'hold') resumeStream(s)
  else tickStream(s)
}

// A tap while the answer is being typed: pause, or go on. True if used.
function tapStream(): boolean {
  const s = stream
  if (!s || s.timer === null) return false
  if (s.mode === 'follow') freezeStream()
  else resumeStream(s)
  return true
}

function showThinking(question: string): void {
  stopThinking = startLiveStatus(
    sessionToken,
    (dots, elapsedSeconds) => {
      setContent(
        `${youLine(question)}${DIVIDER}Thinking${dots} (${elapsedSeconds}s)${thinkingRetryNote}`,
      )
    },
    thinkingStartedAt,
  )
}

// The request now out, so a follow-up asked over it (G2-149) can wait for
// its answer before going out itself.
let answering: Promise<void> | null = null

async function askGemini(question: string) {
  preparing++
  const run = askGeminiNow(question)
  answering = run
  try {
    await run
  } finally {
    preparing--
    if (answering === run) answering = null
  }
}

// A new question may start: not while recording or transcribing one, but
// while an answer is still coming it may (G2-149) - "Hey Jarvis" or a long
// press during an answer asks a follow-up in the same chat.
function canListenNow(): boolean {
  return !listening && !transcribing && (preparing === 0 || waitingHere())
}

// Stops showing the answer being typed so the next question can be
// recorded. The request keeps going: its answer is still saved to the chat
// and is part of the follow-up's history.
function interruptAnswer(): void {
  if (!waitingHere()) return
  if (stream) endStream(stream)
  stopThinking?.()
  stopThinking = null
  status('Jarvis: answer continues in the background - listening for a follow-up')
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
  showThinking(question)

  let attemptsMade = 1
  // The answer is typed out as it arrives - see THE ANSWER AS IT IS TYPED.
  // The finished answer then replaces it with the normal paged view below,
  // from its start, where smooth scrolling is back.
  const typed: Stream = {
    header: youLine(question),
    label: modelLabel(llm.provider, llm.model),
    received: '',
    shown: 0,
    budget: 0,
    lastTickAt: Date.now(),
    complete: false,
    fast: false,
    mode: 'follow',
    timer: null,
    drawn: '',
    relevant: () => myAsk === currentAskId && stillRelevant(),
    release: null,
    win: null,
    pending: Promise.resolve(),
  }
  stream = typed
  const onText = (textSoFar: string) => {
    if (stream !== typed) return
    typed.received = textSoFar
    if (typed.timer === null) {
      // The first words: leave the Thinking screen and start typing.
      stopThinking?.()
      stopThinking = null
      typed.lastTickAt = Date.now()
      typed.timer = setInterval(() => tickStream(typed), TYPING_TICK_MS)
      tickStream(typed)
    }
  }
  status(`Jarvis: asking ${describeModel(llm)}`)
  // The request itself is shared with the phone (assistant.ts, G2-70).
  const reply = await askAssistant(llm, messagesAtAsk, targetSessionId, {
    mode: currentMode,
    onText,
    onRetry: (attempt, max) => {
      attemptsMade = attempt
      if (myAsk === currentAskId) thinkingRetryNote = `\nRetrying (${attempt}/${max})...`
    },
  })
  // The model is done, but the typing may still be behind it: let it catch
  // up, or until the wearer taps to skip (G2-106).
  typed.complete = true
  if (reply.kind === 'answer' && stream === typed && typed.timer !== null) {
    await waitForReveal(typed)
  }
  endStream(typed)
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
    if (!stillRelevant() || listening || transcribing) return
    lastErrorQuestion = question
    const triedNote = attemptsMade > 1 ? ` after ${attemptsMade} tries` : ''
    setContent(
      `${youLine(question)}${DIVIDER}Couldn't reach ${providerInfo(llm.provider).label}${triedNote} (${reply.message}).` +
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
      ? { model: withModeTag(modelLabel(llm.provider, reply.model ?? llm.model)) }
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
    currentMode = 'auto'
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
  // A follow-up is being recorded over this answer (G2-149): keep its
  // screen; the answer is in the chat for when the wearer looks back.
  if (listening || transcribing) return
  const firstPage = renderConversation()
  if (typed.outcome === 'caught-up' && typed.mode === 'follow') {
    // The typing caught up by itself: the wearer is reading the last lines,
    // so leave them there instead of jumping back to the first (G2-107).
    const rows = rowsOf(typed.received, PAGE_INNER_WIDTH)
    tailView = { rows, win: tailWin(rows) }
  } else {
    void showPage(firstPage)
  }
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
  // With Gemini Live the words are already written: no transcribing wait.
  setContent(
    isLiveTranscribing()
      ? 'Sending...'
      : `Transcribing ${recordedSeconds}s of speech...\n\n(this can take a moment)`,
  )
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
      void showPage(renderConversation())
      return
    }
    if (depth !== 'conversation' || currentSessionId !== sessionIdBeforeAsking || listening) {
      status('Jarvis: question dropped - the screen changed before asking')
      return
    }

    // A follow-up asked over an answer still coming (G2-149): that answer
    // goes into the chat first, so this question's history includes it.
    if (answering) {
      setContent('Sending... (the last answer is still arriving)')
      await answering
      if (depth !== 'conversation' || currentSessionId !== sessionIdBeforeAsking || listening) {
        status('Jarvis: question dropped - the screen changed while waiting')
        return
      }
    }

    // Added in memory right away, no await - the old version awaited a
    // storage write here before asking Gemini, which is exactly the kind of
    // wait a slow or stuck host read turned into a frozen screen.
    if (currentSessionId === null) {
      const created = chatSessions.newSession(question, currentMode)
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
  if (stream) endStream(stream)
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
    showThinking(inFlightQuestion)
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
  if (full !== rebuildSafe(full)) void showPage(full)
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
  contentKind: () => (depth !== 'conversation' ? 'list' : codeView ? 'tiles' : 'text'),
  listItems: () =>
    depth === 'history'
      ? historyRows(exchangesOf(currentMessages)).map(r => r.label)
      : [...NEW_CHAT_ROWS, ...pickerSessions.map(s => pickerTitle(s.title))],
  onListSelect: index => {
    if (depth === 'history') {
      const exchanges = exchangesOf(currentMessages)
      const row = historyRows(exchanges)[index]
      if (!row) return
      focus = { index: row.index, of: exchanges.length }
      depth = 'conversation'
      pages = []
      publishScreen()
      return
    }
    if (depth !== 'picker') return
    focus = null
    listenWhenReady = index < NEW_CHAT_ROWS.length
    if (index < NEW_CHAT_ROWS.length) {
      currentSessionId = null
      currentMessages = []
      currentSessionTitle = null
      currentMode = MODES[index].id
    } else {
      const picked = pickerSessions[index - NEW_CHAT_ROWS.length]
      if (!picked) return
      currentSessionId = picked.id
      currentMessages = picked.messages
      currentSessionTitle = picked.title
      currentMode = modeOf(picked.mode).id
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
    // From the list of exchanges: ask the next question of this chat.
    if (depth === 'history') {
      if (busy()) return
      depth = 'conversation'
      focus = null
      pages = []
      requestRebuild(chatTool, () => {
        if (depth === 'conversation' && !busy()) void beginListening()
      })
      return
    }
    // Not while this conversation is still recording or transcribing; over
    // an answer still coming, it asks a follow-up (G2-149).
    if (depth !== 'conversation' || !canListenNow()) return
    interruptAnswer()
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
    currentMode = 'auto'
    currentMessages = []
    currentSessionTitle = null
    lastErrorQuestion = null
    pages = []
    publishScreen()
    return 'tool'
  },
  onClose: () => {
    codeView = null
    setStatusNote(null)
    stopListeningIfAny()
  },
  onTap: () => {
    if (tapStream()) return
    if (depth !== 'conversation' || busy()) return
    if (codeView) moveCode(1)
    else openCodeView()
  },
  // Double-tap steps back one level, no question asked, until the chat list
  // (G2-102): code > question and answer > exchanges > chats > launcher.
  // Mid-recording or answering, and in a conversation started from another
  // screen, it still goes through the leave prompt.
  onBack: () => {
    if (codeView) {
      closeCodeView()
      return true
    }
    if (depth === 'history') {
      leaveToPicker()
      return true
    }
    if (depth === 'conversation' && !quickAsk && !busy()) {
      openHistory()
      return true
    }
    return false
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
  onSuspend: () => {
    stopListeningIfAny()
    setStatusNote(null)
  },
  onResume: () => {
    resume()
    updatePositionNote()
  },
  // Called only for a swipe at a page's top (-1) or bottom (1) edge - the
  // firmware handles scrolling within a page itself. Turns the page per the
  // arm-then-turn rule above. Ignored while anything other than the
  // conversation is on screen - recording, transcribing, thinking - which
  // is exactly when pages is empty or a live status is running.
  onScroll: delta => {
    // While the answer is being typed or paused (G2-107, G2-111): a swipe up
    // pauses and goes back a window, a swipe down skips to the end; paused,
    // both ways read over what has arrived.
    if (stream && stream.timer !== null) {
      if (stream.mode === 'follow') {
        // Up pauses and goes back a window; down skips to the end.
        if (delta === -1) {
          const paused = freezeStream()
          if (paused) moveHold(paused, -1)
        } else {
          skipToEnd(stream)
        }
      } else {
        moveHold(stream, delta)
      }
      return
    }
    if (codeView) {
      moveCode(delta)
      return
    }
    // The finished tail: read up and down over the answer a page at a time.
    if (tailView && depth === 'conversation') {
      const now = Date.now()
      if (now - lastScrollAt < SCROLL_COOLDOWN_MS) return
      lastScrollAt = now
      const view = tailView
      const next = moveView(view.rows, view.win, delta)
      if (next) {
        view.win = next
        const text = windowText(view.rows, next)
        void showPage(
          text,
          redoView(view.rows, next.start, w => (view.win = w)),
        )
        updatePositionNote()
      }
      return
    }
    if (depth !== 'conversation' || listening || stopActiveStatus !== null) return
    if (pages.length <= 1) return
    const now = Date.now()
    if (now - lastScrollAt < SCROLL_COOLDOWN_MS) return
    lastScrollAt = now
    const next = movePaged(
      pages.map(p => p.text.split(/\n/).length),
      { page: pageIndex, win: pageWin },
      delta,
    )
    if (!next) return
    // The firmware only reports a swipe at a section's very top or bottom,
    // so one swipe there moves on - no second "are you sure" swipe.
    pageIndex = next.page
    pageWin = next.win
    updatePositionNote()
    // Any content update starts at the top of what it shows, so going back
    // shows the last screenful of the page above (G2-124).
    const lines = pages[pageIndex].text.split(/\n/)
    void showPage(
      pageWin ? lines.slice(pageWin.start, pageWin.end).join('\n') : pages[pageIndex].text,
    )
  },
  // Never actually rendered for the picker (contentKind is 'list' there).
  // For a conversation: the page already being read, if any - so "No" on the
  // leave prompt, which rebuilds this same page, puts the wearer back on it
  // rather than at the start of the answer. Otherwise the first page of the
  // latest exchange. Every page is under the firmware's 1000-character
  // ceiling for a rebuild (features/chat/paging.ts's PAGE_MAX_CHARS).
  // A rebuild carries at most 1000 characters; a longer section shows its
  // start, and onContentReady fills in the rest.
  initialContent: () => {
    tailView = null
    pageWin = null
    return rebuildSafe(pages.length > 0 ? pages[pageIndex].text : renderConversation())
  },
}
