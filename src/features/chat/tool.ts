import { cancel, start, stop } from '../../core/voiceCapture'
import { converse, type GeminiTurn } from '../../core/gemini'
import { getApiKey as getGeminiApiKey } from '../../core/geminiSettings'
import { chatSessions, type ChatMessage, type ChatSession } from './store'
import { setContent } from '../../platform/page'
import { setCurrentScreen } from '../../core/currentScreen'
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

// null means "New chat" was picked - no session exists yet, one is created
// the moment the first exchange actually happens (see store.ts's own
// appendMessage, which takes a null id to mean exactly this).
let currentSessionId: string | null = null
let currentMessages: ChatMessage[] = []

// Mirrors chatSessions.appendMessage's own title choice (see store.ts) for
// whichever session is currently open, so onBack can fold it back into
// pickerSessions without an async storage read - onBack runs synchronously,
// same requirement as onListSelect (see the Tool interface). Stays null
// until the first exchange actually creates or touches a session.
let currentSessionTitle: string | null = null

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

async function refresh(): Promise<void> {
  const all = (await chatSessions.readAll()).sort((a, b) => b.updatedAt - a.updatedAt)
  pickerSessions = all.slice(0, PICKER_MAX_SESSIONS)
  depth = 'picker'
  currentSessionId = null
  currentMessages = []
  currentSessionTitle = null
}

// Folds the currently open session back into pickerSessions in memory, no
// storage read needed - every exchange is already written to storage the
// moment it happens (see chatSessions.appendMessage in store.ts), this just
// keeps the in-memory picker list from showing stale data (a missing new
// session, or an old title/position) on the way back to it. Called from
// onBack, which must be synchronous (same requirement as onListSelect), so
// this cannot simply re-run refresh()'s own async readAll.
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

// Only the latest exchange, not the running history - per direct request,
// after older messages were still eating most of the room Gemini's own
// answer needed. The glasses screen shows the question that produced the
// CURRENT answer and that answer, nothing further back; the full history,
// every older exchange included, is what the companion page's chat-view is
// for (see companion/main.ts) - a real browser view with no size limit at
// all, unlike this one.
//
// Two budgets, not one, because the firmware's own hard character ceiling
// (docs/platform.md) is NOT the same for every call: 1000 on create/rebuild
// (what initialContent feeds into), 2000 on a later textContainerUpgrade
// (what every setContent() call during an active session uses). Using the
// stricter number everywhere would cut an answer in half for no reason on
// every call except the very first one. Both numbers are left with a little
// margin rather than riding right up to the measured figure, since this is
// a firmware limit we measured, not a guarantee it is exact to the byte.
// Per direct request, this is meant to let an answer run as long as it
// actually needs and be read by scrolling, not be cut short on purpose -
// LIVE_CHAR_BUDGET is set as close to the real 2000-char ceiling as that
// margin allows, which is what every answer actually renders through.
const ENTRY_CHAR_BUDGET = 900
const LIVE_CHAR_BUDGET = 1900
const TRUNCATION_NOTE = '\n\n(continued - read the rest on the companion page)'

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

function clampToBudget(text: string, budget: number): string {
  if (text.length <= budget) return text
  return text.slice(0, Math.max(budget - TRUNCATION_NOTE.length, 0)) + TRUNCATION_NOTE
}

// The last message, plus the one before it if that is the question which
// produced it (always true in normal use - messages strictly alternate
// user/model) - not the whole array. Handles the one case where the last
// two entries are NOT a question-then-answer pair (picking a session whose
// final message happens to be a user question with no reply yet, e.g. a
// prior attempt that never got a Gemini answer) by only pairing them up
// when the roles actually differ.
function renderConversation(budget: number): string {
  if (currentMessages.length === 0) return 'No messages yet.\n\nLong-press to ask something.'
  const last = currentMessages[currentMessages.length - 1]
  const secondLast = currentMessages[currentMessages.length - 2]
  const parts =
    secondLast && secondLast.role !== last.role
      ? [formatMessage(secondLast), formatMessage(last)]
      : [formatMessage(last)]
  return clampToBudget(parts.join(DIVIDER), budget)
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
): () => void {
  stopActiveStatus?.()
  const startedAt = Date.now()
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

async function beginListening() {
  const mySession = ++sessionToken
  listening = true
  // A new recording means a new question, not a retry of the old one -
  // once the wearer starts speaking again, whatever failed before is no
  // longer what a tap should resend.
  lastErrorQuestion = null
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
async function askGemini(question: string, mySession: number) {
  const apiKey = await getGeminiApiKey()
  if (mySession !== sessionToken) return
  if (!apiKey) {
    setContent(
      'No Gemini API key set up yet.\n\n' +
        'Add one on the companion page (Gemini or Jarvis), then try again.',
    )
    return
  }

  // Shows the question immediately, before Gemini has answered, and keeps
  // showing elapsed time rather than a static word - safe to animate,
  // unlike live captions (see the Jarvis history this session): this is a
  // fixed string on a timer, not Whisper inference running repeatedly on
  // the main thread, so there is nothing here that can block input
  // processing the way that did. Stops itself the moment this session
  // goes stale (closed/suspended while waiting), so a tick never lands on
  // a container that moved on.
  startLiveStatus(mySession, (dots, elapsedSeconds) => {
    setContent(
      clampToBudget(
        `You: ${question}${DIVIDER}Thinking${dots} (${elapsedSeconds}s)`,
        LIVE_CHAR_BUDGET,
      ),
    )
  })

  // concise: false - this is Chat's whole point, a real conversation read by
  // scrolling, not Jarvis's glance-and-go fallback. See core/gemini.ts.
  const reply = await converse(apiKey, toGeminiTurns(currentMessages), false)
  stopActiveStatus?.()
  if (mySession !== sessionToken) return

  if (reply.kind === 'error') {
    lastErrorQuestion = question
    setContent(
      clampToBudget(
        `You: ${question}${DIVIDER}Couldn't reach Gemini (${reply.message}).` +
          '\n\n(tap to retry, double-tap to go back)',
        LIVE_CHAR_BUDGET,
      ),
    )
    return
  }

  lastErrorQuestion = null
  const answer: ChatMessage = { role: 'model', text: reply.text, timestamp: Date.now() }
  const sessionAfterAnswer = await chatSessions.appendMessage(currentSessionId, answer)
  if (mySession !== sessionToken) return
  currentSessionTitle = sessionAfterAnswer.title
  currentMessages = sessionAfterAnswer.messages
  setContent(renderConversation(LIVE_CHAR_BUDGET))
  // Republishes the same session id - still worth it, since the companion
  // page re-fetches on every publish and this is the moment the full
  // answer actually lands in storage for it to read.
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
  const mySession = sessionToken
  listening = false
  // Stop the Listening counter now, not whenever the next startLiveStatus
  // call happens to land - otherwise it keeps ticking (and overwriting
  // the screen) all through transcription, and would overwrite the
  // "Didn't catch that" error below entirely, since nothing else would
  // ever stop it on that path.
  stopActiveStatus?.()
  const result = await stop()
  if (mySession !== sessionToken) return

  if (result.kind === 'error') {
    setContent(`Didn't catch that (${result.message}).\n\nLong-press to try again.`)
    return
  }

  const question: ChatMessage = { role: 'user', text: result.transcript, timestamp: Date.now() }
  const sessionAfterQuestion = await chatSessions.appendMessage(currentSessionId, question)
  if (mySession !== sessionToken) return
  currentSessionId = sessionAfterQuestion.id
  currentSessionTitle = sessionAfterQuestion.title
  currentMessages = sessionAfterQuestion.messages
  // "New chat" only gets a real id once this first message lands - publish
  // now so the companion page can follow to the right session the moment
  // it exists, rather than only once Gemini has actually answered.
  publishScreen()

  await askGemini(result.transcript, mySession)
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
  if (lastErrorQuestion === null) return
  const question = lastErrorQuestion
  const mySession = ++sessionToken
  await askGemini(question, mySession)
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
  }
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
  listItems: () => ['New chat', ...pickerSessions.map(s => s.title)],
  onListSelect: index => {
    if (depth !== 'picker') return
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
    publishScreen()
    return 'tool'
  },
  onClose: stopListeningIfAny,
  onSuspend: stopListeningIfAny,
  // Never actually rendered for the picker (contentKind is 'list' there);
  // for 'conversation' this is what a fresh rebuild into the depth reads
  // (see onListSelect above) before any listening has happened yet. Goes
  // through create/rebuild, the stricter of the two firmware limits, hence
  // the smaller budget (see ENTRY_CHAR_BUDGET above).
  initialContent: () => renderConversation(ENTRY_CHAR_BUDGET),
}
