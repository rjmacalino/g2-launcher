import { cancel, start, stop } from '../../core/voiceCapture'
import { converse, type GeminiTurn } from '../../core/gemini'
import { getApiKey as getGeminiApiKey } from '../../core/geminiSettings'
import { chatSessions, type ChatMessage, type ChatSession } from './store'
import { setContent } from '../../platform/page'
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
// is the transcript. Unlike Teleprompter, there is no confirmOnExit/leave
// prompt here - nothing is lost by backing out, since each exchange is
// saved to storage the moment Gemini answers, not in a single batch on
// exit. Double-tap still steps back one level before leaving entirely,
// matching what "back" means everywhere else in this app - just through
// onBack (see core/tool.ts) rather than the confirm-prompt dance, since
// there is nothing here worth asking about first.
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
  return clampToBudget(parts.join('\n\n'), budget)
}

function toGeminiTurns(messages: readonly ChatMessage[]): GeminiTurn[] {
  return messages.map(m => ({ role: m.role, text: m.text }))
}

async function beginListening() {
  const mySession = ++sessionToken
  listening = true
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
  setContent('Listening...\n\n(tap when done)')
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
  const result = await stop()
  if (mySession !== sessionToken) return

  if (result.kind === 'error') {
    setContent(`Didn't catch that (${result.message}).\n\nLong-press to try again.`)
    return
  }

  const apiKey = await getGeminiApiKey()
  if (mySession !== sessionToken) return
  if (!apiKey) {
    setContent(
      'No Gemini API key set up yet.\n\n' +
        'Add one on the companion page (Chat or Jarvis), then try again.',
    )
    return
  }

  // Shows the question immediately, before Gemini has answered, rather than
  // leaving the wearer staring at the old screen during the wait. A live
  // setContent call, not the initial build, so this gets the larger budget.
  setContent(clampToBudget(`You: ${result.transcript}\n\nThinking...`, LIVE_CHAR_BUDGET))

  const question: ChatMessage = { role: 'user', text: result.transcript, timestamp: Date.now() }
  const sessionAfterQuestion = await chatSessions.appendMessage(currentSessionId, question)
  if (mySession !== sessionToken) return
  currentSessionId = sessionAfterQuestion.id
  currentSessionTitle = sessionAfterQuestion.title
  currentMessages = sessionAfterQuestion.messages

  // concise: false - this is Chat's whole point, a real conversation read by
  // scrolling, not Jarvis's glance-and-go fallback. See core/gemini.ts.
  const reply = await converse(apiKey, toGeminiTurns(currentMessages), false)
  if (mySession !== sessionToken) return

  if (reply.kind === 'error') {
    setContent(
      clampToBudget(
        `You: ${result.transcript}\n\nCouldn't reach Gemini (${reply.message}).`,
        LIVE_CHAR_BUDGET,
      ),
    )
    return
  }

  const answer: ChatMessage = { role: 'model', text: reply.text, timestamp: Date.now() }
  const sessionAfterAnswer = await chatSessions.appendMessage(currentSessionId, answer)
  if (mySession !== sessionToken) return
  currentSessionTitle = sessionAfterAnswer.title
  currentMessages = sessionAfterAnswer.messages
  setContent(renderConversation(LIVE_CHAR_BUDGET))
}

function stopListeningIfAny() {
  sessionToken++
  if (listening) {
    listening = false
    cancel()
  }
}

export const chatTool: Tool = {
  name: 'Chat',
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
  },
  onLongPress: () => {
    if (depth !== 'conversation' || listening) return
    beginListening()
  },
  // Double-tap steps back to the picker from a conversation, same as
  // "back" everywhere else in this app, rather than jumping straight past
  // it to the launcher menu - see core/tool.ts. No leave prompt: stops a
  // recording in progress if there was one (same cleanup onClose/onSuspend
  // already do), syncs the picker so it reflects whatever was just said
  // (see syncPickerFromCurrent above), and steps back one level.
  onBack: () => {
    if (depth !== 'conversation') return 'menu'
    stopListeningIfAny()
    syncPickerFromCurrent()
    depth = 'picker'
    currentSessionId = null
    currentMessages = []
    currentSessionTitle = null
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
