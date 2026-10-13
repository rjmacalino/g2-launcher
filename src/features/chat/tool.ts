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
// is the transcript. Unlike those two, there is no confirmOnExit here -
// nothing is lost by leaving, since each exchange is saved to storage the
// moment Gemini answers, not in a single batch on exit. Double-tap always
// goes straight to the menu rather than stepping back to the picker first;
// accepted as the simpler shape, matching Jarvis's own "no intermediate
// confirm, no step-back" precedent, over building a second navigation level
// for a "back to the chat list" nicety nothing has asked for yet.
//
// Voice capture is local to this tool, not global like Jarvis's: long press
// only starts listening HERE while Chat's own conversation screen is
// active (the shell carves this tool out from the global
// long-press-reaches-Jarvis reservation the same way it already does for
// Lab - see app/main.ts), and a double-press ends it, exactly like Jarvis's
// own gesture shape, just scoped to one tool instead of every screen.
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

let sessionToken = 0
let listening = false

export function isListening(): boolean {
  return listening
}

async function refresh(): Promise<void> {
  pickerSessions = (await chatSessions.readAll()).sort((a, b) => b.updatedAt - a.updatedAt)
  depth = 'picker'
  currentSessionId = null
  currentMessages = []
}

// Newest first, not oldest first - a real platform constraint, not a design
// preference: text containers have no programmatic scroll position (see
// docs/platform.md), and any content update resets scroll to the top. The
// only way "the latest exchange is what you see by default" can actually be
// true here is for it to BE the top. Older messages are still there, just a
// swipe-down away instead of a swipe-up.
function renderConversation(): string {
  if (currentMessages.length === 0) return 'No messages yet.\n\nLong-press to ask something.'
  const newestFirst = [...currentMessages].reverse()
  return newestFirst.map(m => `${m.role === 'user' ? 'You' : 'Gemini'}: ${m.text}`).join('\n\n')
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
  setContent('Listening...\n\n(double-press when done)')
}

// Ends the current recording, transcribes it, and sends the WHOLE
// conversation so far plus the new question to Gemini in one request -
// Gemini has no memory of its own between calls, so every prior exchange
// has to be resent each time for a follow-up to actually be a follow-up.
// Exported so the shell can call it directly on a double-press while this
// tool's conversation screen is actively listening (see app/main.ts) - same
// shape as Jarvis's own exported finishListening.
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
  // leaving the wearer staring at the old conversation during the wait -
  // placed at the top with the rest of the history below, matching exactly
  // where it will land once saved (see renderConversation's own newest-first
  // reasoning above).
  const olderConversation = renderConversation()
  setContent(`You: ${result.transcript}\n\nThinking...\n\n---\n\n${olderConversation}`)

  const question: ChatMessage = { role: 'user', text: result.transcript, timestamp: Date.now() }
  const sessionAfterQuestion = await chatSessions.appendMessage(currentSessionId, question)
  if (mySession !== sessionToken) return
  currentSessionId = sessionAfterQuestion.id
  currentMessages = sessionAfterQuestion.messages

  const reply = await converse(apiKey, toGeminiTurns(currentMessages))
  if (mySession !== sessionToken) return

  if (reply.kind === 'error') {
    // Same layout as the "Thinking..." state above (question on top, older
    // history below) rather than renderConversation()'s own ordering, which
    // would put the error notice after the OLDER messages instead of right
    // under the question it is actually about.
    setContent(
      `You: ${result.transcript}\n\nCouldn't reach Gemini (${reply.message}).\n\n---\n\n${olderConversation}`,
    )
    return
  }

  const answer: ChatMessage = { role: 'model', text: reply.text, timestamp: Date.now() }
  const sessionAfterAnswer = await chatSessions.appendMessage(currentSessionId, answer)
  if (mySession !== sessionToken) return
  currentMessages = sessionAfterAnswer.messages
  setContent(renderConversation())
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
    } else {
      const picked = pickerSessions[index - 1]
      if (!picked) return
      currentSessionId = picked.id
      currentMessages = picked.messages
    }
    depth = 'conversation'
  },
  onLongPress: () => {
    if (depth !== 'conversation' || listening) return
    beginListening()
  },
  onClose: stopListeningIfAny,
  onSuspend: stopListeningIfAny,
  // Never actually rendered for the picker (contentKind is 'list' there);
  // for 'conversation' this is what a fresh rebuild into the depth reads
  // (see onListSelect above) before any listening has happened yet.
  initialContent: () => renderConversation(),
}
