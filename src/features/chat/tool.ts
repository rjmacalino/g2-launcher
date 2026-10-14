import { cancel, start, stop } from '../../core/voiceCapture'
import { converse, type GeminiTurn } from '../../core/gemini'
import { getApiKey as getGeminiApiKey } from '../../core/geminiSettings'
import { chatSessions, type ChatMessage, type ChatSession } from './store'
import { setContent } from '../../platform/page'
import { status } from '../../platform/bridge'
import { PAGE_INNER_WIDTH, paginate, type Page } from './paging'
import { setCurrentScreen } from '../../core/currentScreen'
import { requestRebuild } from '../../core/rebuild'
import type { Tool } from '../../core/tool'

// A real multi-turn conversation, unlike Jarvis's one-shot command/question
// fallback (core/voiceDispatch.ts) - the whole point here is a follow-up
// remembers what came before, and the conversation itself is a place the
// wearer comes back to, not a quick interrupt. Per direct decision, kept
// entirely separate from Jarvis rather than folding this into it: Jarvis's
// value is being reachable from ANY screen for a quick answer with an
// auto-return; a sit-down conversation with history is a different shape
// of interaction that would only get in the way of that.
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
// Voice capture is local to this tool, not global like Jarvis's: long press
// only starts listening HERE while Chat's own conversation screen is
// active (the shell carves this tool out from the global
// long-press-reaches-Jarvis reservation the same way it already does for
// Lab - see app/main.ts). Ending it is a single tap, not Jarvis's
// double-press - per direct request, double-tap felt wrong for a
// conversation the wearer is actively having (see the isSingleTap carve-out
// in app/main.ts).
type Depth = 'picker' | 'conversation'
let depth: Depth = 'picker'

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
function publishScreen(): void {
  const detail: ChatScreenDetail =
    depth === 'picker'
      ? { depth: 'picker' }
      : { depth: 'conversation', sessionId: currentSessionId }
  setCurrentScreen({ kind: 'tool', name: 'Gemini', detail })
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
  depth = 'picker'
  currentSessionId = null
  currentMessages = []
  currentSessionTitle = null
  lastErrorQuestion = null
  interrupted = false
  listenWhenReady = false
  pages = []
  const cached = chatSessions.peek()
  pickerSessions = sortForPicker(cached ?? [])
  if (cached === null) {
    void chatSessions.readAll().then(loaded => {
      if (depth !== 'picker') return
      pickerSessions = sortForPicker(loaded)
      // The shell ignores this unless Gemini is actually the page on
      // screen (see app/main.ts's rebuild handler).
      requestRebuild(chatTool)
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
let armedDirection: 1 | -1 | 0 = 0
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

function formatMessage(m: ChatMessage): string {
  return `${m.role === 'user' ? 'You' : 'Gemini'}: ${m.text}`
}

// The latest exchange only - the last message, plus the one before it if
// that is the question which produced it (always true in normal use -
// messages strictly alternate user/model). Earlier exchanges in the same
// conversation are on the companion page. Returns the FIRST page and
// resets paging to it, so a new answer always opens at its start.
function renderConversation(): string {
  if (currentMessages.length === 0) {
    pages = []
    // Shown for the moment between picking "New chat" and the microphone
    // starting (see onContentReady), rather than an instruction to
    // long-press that is about to be done for the wearer anyway.
    return listenWhenReady
      ? 'Starting the microphone...'
      : 'No messages yet.\n\nLong-press to ask something.'
  }
  const last = currentMessages[currentMessages.length - 1]
  const secondLast = currentMessages[currentMessages.length - 2]
  const parts =
    secondLast && secondLast.role !== last.role
      ? [formatMessage(secondLast), formatMessage(last)]
      : [formatMessage(last)]
  pages = paginate(parts.join(DIVIDER), PAGE_INNER_WIDTH)
  pageIndex = 0
  armedDirection = 0
  return pages[0].text
}

function toGeminiTurns(messages: readonly ChatMessage[]): GeminiTurn[] {
  return messages.map(m => ({ role: m.role, text: m.text }))
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

async function beginListening() {
  const mySession = ++sessionToken
  listening = true
  interrupted = false
  // A new recording means a new question, not a retry of the old one -
  // once the wearer starts speaking again, whatever failed before is no
  // longer what a tap should resend.
  lastErrorQuestion = null
  pages = []
  const ok = await start(() => {
    if (mySession !== sessionToken) return
    finishListening()
  })
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
  status('Gemini: recording')
  startLiveStatus(mySession, (dots, elapsedSeconds) => {
    setContent(`Listening${dots} (${elapsedSeconds}s)\n\n(tap when done)`)
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

function showThinking(question: string): void {
  startLiveStatus(
    sessionToken,
    (dots, elapsedSeconds) => {
      setContent(
        `You: ${shortQuestion(question)}${DIVIDER}Thinking${dots} (${elapsedSeconds}s)${thinkingRetryNote}`,
      )
    },
    thinkingStartedAt,
  )
}

async function askGemini(question: string) {
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

  const apiKey = await getGeminiApiKey()
  // Not the voice-capture session token - see finishListening for how that
  // silently dropped questions on a brief trip to the background.
  if (!stillRelevant()) return
  if (!apiKey) {
    setContent(
      'No Gemini API key set up yet.\n\n' +
        'Add one on the companion page (Gemini or Jarvis), then try again.',
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
  thinkingStartedAt = Date.now()
  thinkingRetryNote = ''
  inFlightQuestion = question
  status('Gemini: asking')
  showThinking(question)

  let attemptsMade = 1
  // concise: false - this is Chat's whole point, a real conversation read by
  // scrolling, not Jarvis's glance-and-go fallback. See core/gemini.ts.
  const reply = await converse(apiKey, toGeminiTurns(messagesAtAsk), false, (attempt, max) => {
    attemptsMade = attempt
    thinkingRetryNote = `\nRetrying (${attempt}/${max})...`
  })
  inFlightQuestion = null
  stopActiveStatus?.()
  status(reply.kind === 'error' ? `Gemini: failed (${reply.message})` : 'Gemini: answered')

  if (reply.kind === 'error') {
    if (!stillRelevant()) return
    lastErrorQuestion = question
    const triedNote = attemptsMade > 1 ? ` after ${attemptsMade} tries` : ''
    setContent(
      `You: ${shortQuestion(question)}${DIVIDER}Couldn't reach Gemini${triedNote} (${reply.message}).` +
        '\n\n(tap to retry, double-tap to go back)',
    )
    return
  }

  // Saved regardless of stillRelevant() - the answer belongs to
  // targetSessionId's own history whether or not the wearer is still
  // looking at it, and has to be there the next time it is opened. In the
  // background: nothing about showing the answer waits on storage.
  const answer: ChatMessage = { role: 'model', text: reply.text, timestamp: Date.now() }
  const answeredMessages = [...messagesAtAsk, answer]
  void chatSessions.save({
    id: targetSessionId,
    title: targetTitle ?? '(untitled)',
    messages: answeredMessages,
    updatedAt: Date.now(),
  })
  // Correctness, not a render decision - a retry would be pointless and
  // wrong for a question that just got answered.
  if (lastErrorQuestion === question) lastErrorQuestion = null
  if (!stillRelevant()) return
  currentMessages = answeredMessages
  setContent(renderConversation())
  publishScreen()
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
  status(`Gemini: transcribing ${recordedSeconds}s of audio`)
  setContent(`Transcribing ${recordedSeconds}s of speech...\n\n(this can take a moment)`)
  const result = await stop()
  // Dropped only if the wearer actually moved on - left this conversation,
  // or started a new recording. The old check here was the voice-capture
  // session token, which a brief app-in-background blip also bumps: a
  // question that finished transcribing during one was silently thrown
  // away, leaving "Transcribing" on screen for good.
  if (depth !== 'conversation' || currentSessionId !== sessionIdBeforeAsking || listening) {
    status('Gemini: question dropped - conversation changed while transcribing')
    return
  }

  if (result.kind === 'error') {
    status(`Gemini: transcription failed (${result.message})`)
    setContent(`Didn't catch that (${result.message}).\n\nLong-press to try again.`)
    return
  }
  // Added in memory right away, no await - the old version awaited a
  // storage write here before asking Gemini, which is exactly the kind of
  // wait a slow or stuck host read turned into a frozen screen.
  const question: ChatMessage = { role: 'user', text: result.transcript, timestamp: Date.now() }
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
  if (lastErrorQuestion === null || inFlightQuestion !== null) return
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
    status('Gemini: recording stopped before it was finished')
  }
}

// Back from the background (or the system menu, which reports the same
// way - docs/platform.md, Contextual menu). Puts back whatever going to the
// background stopped: an interrupted recording becomes a clear message,
// and a question still waiting on Gemini gets its "Thinking" counter back.
function resume(): void {
  if (depth !== 'conversation') return
  if (interrupted) {
    interrupted = false
    pages = []
    setContent('Recording was interrupted.\n\nLong-press to ask again.')
    return
  }
  if (inFlightQuestion !== null && stopActiveStatus === null) showThinking(inFlightQuestion)
}

export const chatTool: Tool = {
  name: 'Gemini',
  // Always, in both the picker and a conversation, per direct request to
  // follow the same convention Teleprompter already settled on: an
  // accidental double-tap should be double-checked no matter which screen
  // it happens on, regardless of whether anything would actually be lost.
  confirmOnExit: () => true,
  // Matches onConfirmedExit's own logic exactly, same reasoning as
  // Teleprompter's own pair of these two: one describes what pressing Yes
  // says, the other is what it does.
  confirmPrompt: () => (depth === 'conversation' ? 'Leave this conversation?' : 'Leave Gemini?'),
  beforeOpen: refresh,
  contentKind: () => (depth === 'picker' ? 'list' : 'text'),
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
    lastErrorQuestion = null
    interrupted = false
    pages = []
    publishScreen()
  },
  // Re-asserts this tool's own detail after the shell's generic baseline
  // publish (see app/main.ts's setCurrentScreen calls in openTool/restore,
  // both of which call onOpen AFTER that baseline) - onListSelect and
  // onConfirmedExit publish their own detail directly and need no help,
  // since nothing the shell does between them and their rebuild touches
  // currentScreen at all; a fresh open is the one path with no such hook
  // of its own until now.
  onOpen: publishScreen,
  // The conversation page is on screen now (the shell calls this once the
  // rebuild from picking a picker row has landed). "New chat" goes straight
  // to recording - per direct request, there is nothing else to do on an
  // empty conversation, so making the wearer long-press first was a wasted
  // step. Waits for this moment rather than starting in onListSelect,
  // because the Listening counter needs the page's text container to exist.
  onContentReady: () => {
    if (!listenWhenReady) return
    listenWhenReady = false
    if (depth === 'conversation' && !listening) void beginListening()
  },
  onLongPress: () => {
    if (depth !== 'conversation' || listening) return
    beginListening()
  },
  // Confirming "leave" backs up exactly one level, matching what "back"
  // means everywhere else in this app and exactly mirroring Teleprompter's
  // own onConfirmedExit: from a conversation, Yes steps back to the
  // picker rather than leaving Gemini entirely; from the picker itself,
  // there is nowhere shallower left, so Yes really does leave. Stops a
  // recording in progress if there was one (same cleanup onClose/onSuspend
  // already do), and syncs the picker so it reflects whatever was just
  // said (see syncPickerFromCurrent above).
  onConfirmedExit: () => {
    if (depth !== 'conversation') return 'menu'
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
  onClose: stopListeningIfAny,
  onSuspend: stopListeningIfAny,
  onResume: resume,
  // Called only for a swipe at a page's top (-1) or bottom (1) edge - the
  // firmware handles scrolling within a page itself. Turns the page per the
  // arm-then-turn rule above. Ignored while anything other than the
  // conversation is on screen - recording, transcribing, thinking - which
  // is exactly when pages is empty or a live status is running.
  onScroll: delta => {
    if (depth !== 'conversation' || listening || stopActiveStatus !== null) return
    if (pages.length <= 1) return
    const now = Date.now()
    if (now - lastScrollAt < SCROLL_COOLDOWN_MS) return
    lastScrollAt = now
    const next = Math.min(Math.max(pageIndex + delta, 0), pages.length - 1)
    if (next === pageIndex) return
    if (!pages[pageIndex].fitsOneScreen && armedDirection !== delta) {
      armedDirection = delta
      return
    }
    armedDirection = 0
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
  initialContent: () => (pages.length > 0 ? pages[pageIndex].text : renderConversation()),
}
