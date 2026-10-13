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

function writeAllSessions(all: ChatSession[]): Promise<boolean> {
  return bridge.setLocalStorage(STORAGE_KEY, JSON.stringify(all)).then(ok => {
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
