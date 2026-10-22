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
  // Web pages an answer drew on, when the AI searched (G2-76). Shown on
  // the phone; the glasses show only the answer.
  sources?: { title: string; url: string }[]
  // Which AI wrote an answer, as shown to the wearer (G2-97), e.g.
  // "Gemini 3.6 Flash". Absent on answers saved before then.
  model?: string
}

export type ChatSession = {
  id: string
  title: string
  messages: ChatMessage[]
  updatedAt: number
  // The chat's mode (G2-139, core/modes.ts); absent means Auto.
  mode?: string
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

// Every session's full history lives in this one key as a single JSON blob,
// so both caps below exist to keep that blob small: a count cap, and a cap
// on its actual stored size, which is what really matters to the host's
// storage bridge (a count alone stopped bounding size once Gemini answers
// were allowed to run long - see core/gemini.ts).
const MAX_STORED_SESSIONS = 40
const MAX_STORED_CHARS = 20_000

// THE SHAPE OF THIS FILE, AND WHY.
//
// Real-hardware history [HW]: Gemini repeatedly failed to open at all
// ("Failed to open Gemini: timed out") whenever ANY saved chat existed,
// and deleting every chat from the companion page always fixed it. Every
// other tool opened fine. platform/storage.ts already records what this
// project learned about this host: storage reads normally resolve in
// milliseconds, and a slow one is really a read the host never answers.
// Size caps alone did not make it go away, which points at something
// about the stored VALUE itself, not just its length - the exact trigger
// in the host is not known (the SDK is obfuscated).
//
// So this no longer lets a storage read sit on any path the wearer waits
// on:
//
// - The stored list is read once, in the background, at app startup
//   (preload), and kept in memory. Opening Gemini reads that cache
//   (peek), never storage. features/chat/tool.ts redraws its picker if the
//   load finishes after it has already opened.
// - The conversation itself lives in memory in features/chat/tool.ts.
//   Saving happens in the background (save never needs to be awaited),
//   so a slow or stuck host can delay persistence but can no longer
//   freeze the screen mid-question.
// - Everything written is ASCII-only: every non-ASCII character is stored
//   as a \u escape (JSON.parse turns it back). Gemini answers routinely
//   contain curly quotes, dashes and emoji, and a host bridge that
//   mishandles some characters would explain exactly why specific chats
//   broke reads while deleting them fixed it. Unconfirmed, but cheap, and
//   it removes a whole class of value-dependent failure either way.
// - A slow load reports its time and size on the status line, so the next
//   occurrence comes with numbers instead of guesses.

let cache: ChatSession[] | null = null
let loadPromise: Promise<void> | null = null

// Status-line reports, for the diagnosis above.
const SLOW_LOAD_REPORT_MS = 1000
const STUCK_LOAD_REPORT_MS = 5000

function parseSessions(raw: string): ChatSession[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isChatSession) : []
  } catch {
    return []
  }
}

// Escapes every character at or above 0x7f as \uXXXX. A loop over char
// codes rather than a regex with \u ranges in it: this repo's source files
// are ASCII-only, and editing tools here have turned \u escapes into the
// literal characters before (see CLAUDE.md).
function toStorageString(sessions: ChatSession[]): string {
  const json = JSON.stringify(sessions)
  let out = ''
  for (let i = 0; i < json.length; i++) {
    const code = json.charCodeAt(i)
    out += code < 0x7f ? json[i] : '\\u' + code.toString(16).padStart(4, '0')
  }
  return out
}

// Newest first, then the count cap, then the size cap. When the size cap
// bites, the oldest sessions go first; a single session that is alone over
// budget (one very long conversation) loses its own oldest messages instead
// of disappearing outright.
function bound(sessions: ChatSession[]): ChatSession[] {
  let kept = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_STORED_SESSIONS)
  while (kept.length > 1 && toStorageString(kept).length > MAX_STORED_CHARS) {
    kept = kept.slice(0, -1)
  }
  if (kept.length === 1 && toStorageString(kept).length > MAX_STORED_CHARS) {
    const [only] = kept
    let messages = only.messages
    while (
      messages.length > 1 &&
      toStorageString([{ ...only, messages }]).length > MAX_STORED_CHARS
    ) {
      messages = messages.slice(1)
    }
    kept = [{ ...only, messages }]
  }
  return kept
}

// One write at a time, each writing whatever the cache holds when its turn
// comes - so a burst of saves collapses into correct, ordered writes rather
// than two in-flight writes racing to be last.
let writeQueue: Promise<void> = Promise.resolve()

function persist(): void {
  writeQueue = writeQueue.then(() => {
    if (!cache) return
    return bridge.setLocalStorage(STORAGE_KEY, toStorageString(cache)).then(
      ok => {
        if (!ok) status('Failed to save chat history')
      },
      () => status('Failed to save chat history'),
    )
  })
}

// Single shared load. Never rejects. Rewrites the stored value whenever it
// is not already in the bounded, ASCII-safe form, which also migrates any
// data saved before this existed the first time it loads.
function load(): Promise<void> {
  if (!loadPromise) {
    const started = Date.now()
    const stuckNotice = setTimeout(() => {
      status(`Chat history still loading after ${STUCK_LOAD_REPORT_MS / 1000}s`)
    }, STUCK_LOAD_REPORT_MS)
    loadPromise = bridge
      .getLocalStorage(STORAGE_KEY)
      .then(
        raw => raw ?? '',
        () => '',
      )
      .then(raw => {
        clearTimeout(stuckNotice)
        const ms = Date.now() - started
        if (ms > SLOW_LOAD_REPORT_MS) {
          status(`Chat history load took ${(ms / 1000).toFixed(1)}s (${raw.length} chars)`)
        }
        cache = bound(parseSessions(raw))
        if (raw !== '' && toStorageString(cache) !== raw) persist()
      })
  }
  return loadPromise
}

// Kicked off once at startup (see app/main.ts), not awaited, so the cache is
// usually warm long before Gemini is first opened.
function preload(): void {
  void load()
}

// What is in memory right now, without waiting. null means the startup load
// has not finished yet - not "no chats".
function peek(): ChatSession[] | null {
  return cache ? [...cache] : null
}

// Waits for the load. For the companion page, which can afford to wait,
// and has no timeout to give up against.
async function readAll(): Promise<ChatSession[]> {
  await load()
  return [...(cache ?? [])]
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

// Builds a new session around its first message. No I/O - the caller saves
// it, so it can start using the session (and its id) immediately.
function newSession(first: ChatMessage, mode?: string): ChatSession {
  return {
    id: newId(),
    title: titleFrom(first.text),
    messages: [first],
    updatedAt: Date.now(),
    ...(mode && mode !== 'auto' ? { mode } : {}),
  }
}

// Inserts or replaces a whole session by id. Waits for the initial load
// before touching anything, so it can never overwrite history it has not
// seen yet - which also means a caller should not await it on any path the
// wearer is waiting on.
async function save(session: ChatSession): Promise<void> {
  await load()
  const others = (cache ?? []).filter(s => s.id !== session.id)
  // A save that does not mention the mode keeps the one the chat has.
  const before = (cache ?? []).find(s => s.id === session.id)
  const mode = session.mode ?? before?.mode
  cache = bound([{ ...session, ...(mode ? { mode } : {}), updatedAt: Date.now() }, ...others])
  persist()
  notify()
}

async function remove(id: string): Promise<void> {
  await load()
  cache = (cache ?? []).filter(s => s.id !== id)
  persist()
  notify()
}

// Conversations change from two places now (G2-70): the glasses and the
// phone, which can each ask Jarvis, and the phone can delete. Anything
// showing conversations subscribes here and redraws - announced as soon
// as the in-memory copy changes, not after the storage write.
const listeners = new Set<() => void>()

function notify(): void {
  // A copy - see core/currentScreen.ts's setCurrentScreen.
  for (const fn of [...listeners]) fn()
}

function onChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export const chatSessions = { preload, peek, readAll, newSession, save, remove, onChange }
