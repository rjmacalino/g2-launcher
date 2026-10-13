import { bridge, status } from '../../platform/bridge'
import { newId } from '../../platform/collection'

// A chat session is a running conversation with Gemini, not a single
// question-and-answer like Jarvis's own fallback (see core/voiceDispatch.ts)
// - the whole point here is a follow-up remembers what came before.
// ChatMessage's shape matches core/gemini.ts's own GeminiTurn (role: 'user'
// | 'model', Gemini's own naming, not ours to invent) plus a timestamp, so a
// stored conversation can be replayed straight into a request with no
// translation step.
export type ChatMessage = {
  role: 'user' | 'model'
  text: string
  timestamp: number
}

export type ChatSession = {
  id: string
  title: string
  messages: ChatMessage[]
  updatedAt: number
}

function isChatMessage(x: unknown): x is ChatMessage {
  if (!x || typeof x !== 'object') return false
  const m = x as Record<string, unknown>
  return (
    (m.role === 'user' || m.role === 'model') &&
    typeof m.text === 'string' &&
    typeof m.timestamp === 'number'
  )
}

function isChatSession(x: unknown): x is ChatSession {
  if (!x || typeof x !== 'object') return false
  const s = x as Record<string, unknown>
  return (
    typeof s.id === 'string' &&
    typeof s.title === 'string' &&
    Array.isArray(s.messages) &&
    s.messages.every(isChatMessage) &&
    typeof s.updatedAt === 'number'
  )
}

const STORAGE_KEY = 'chat.sessions'

// Same platform limit Notes' own list items are clamped to (see
// features/notes/store.ts) - a list item holds at most 64 characters.
const TITLE_MAX_CHARS = 64

// Every session's FULL message history lives in this one storage key as a
// single JSON blob (see readAllSessions/writeAllSessions below) - there is
// no per-session key, no pagination, nothing bounding how big that blob can
// get on its own. Confirmed the hard way [HW]: after enough real testing,
// Chat stopped opening at all, with no error anywhere to explain why -
// features/chat/tool.ts's own picker was already capped at 19 *displayed*
// items by that point, which did not help, and the fix that did was
// deleting every saved session, which only makes sense if something about
// reading or writing that one blob back was failing once it grew large
// enough (most likely the bridge's own local-storage read/write, which
// nothing here has a documented size limit for). Pruning the oldest
// sessions here, on every write, keeps that blob bounded permanently
// instead of trusting it to stay small. The companion page's own
// chat-view still reads whatever is left under this cap; nothing about
// this changes what a session looks like once saved, only how many can
// pile up before the oldest start getting dropped.
const MAX_STORED_SESSIONS = 40

async function readAllSessions(): Promise<ChatSession[]> {
  try {
    const raw = await bridge.getLocalStorage(STORAGE_KEY)
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isChatSession)
  } catch {
    return []
  }
}

// Pruned to MAX_STORED_SESSIONS here, the one place every write goes
// through, rather than in each caller - keeps the oldest-first drop rule in
// exactly one place regardless of which path (a new session, an existing
// one growing by a message, a future bulk import) produced the array being
// saved.
function writeAllSessions(all: ChatSession[]): Promise<boolean> {
  const bounded = [...all].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_STORED_SESSIONS)
  return bridge.setLocalStorage(STORAGE_KEY, JSON.stringify(bounded)).then(ok => {
    if (!ok) status('Failed to save chat history')
    return ok
  })
}

// The session's own title, taken from its first message rather than
// authored separately - there is no keyboard on the glasses to type one
// with, and the question that started the conversation is already the
// most honest summary of what it is about.
function titleFrom(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length === 0) return '(untitled)'
  return trimmed.length > TITLE_MAX_CHARS ? `${trimmed.slice(0, TITLE_MAX_CHARS - 3)}...` : trimmed
}

// sessionId null means "start a new session with this as its first
// message" - the one function both a brand new chat and a continuing one
// go through, rather than two separate paths that could drift apart. Falls
// back to starting a new session if the given id no longer exists (deleted
// from elsewhere between reading the picker and asking a question) rather
// than silently dropping the message.
async function appendMessage(sessionId: string | null, message: ChatMessage): Promise<ChatSession> {
  const all = await readAllSessions()

  if (sessionId !== null) {
    const index = all.findIndex(s => s.id === sessionId)
    if (index !== -1) {
      const updated: ChatSession = {
        ...all[index],
        messages: [...all[index].messages, message],
        updatedAt: Date.now(),
      }
      const next = [...all]
      next[index] = updated
      await writeAllSessions(next)
      return updated
    }
  }

  const session: ChatSession = {
    id: newId(),
    title: titleFrom(message.text),
    messages: [message],
    updatedAt: Date.now(),
  }
  await writeAllSessions([...all, session])
  return session
}

async function removeSession(id: string): Promise<void> {
  const all = await readAllSessions()
  await writeAllSessions(all.filter(s => s.id !== id))
}

export const chatSessions = {
  readAll: readAllSessions,
  appendMessage,
  remove: removeSession,
}
