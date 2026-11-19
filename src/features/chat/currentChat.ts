import { modeOf, type ModeId } from '../../shared/modePresets'
import type { ChatMessage, ChatSession } from './store'

// THE CHAT ON SCREEN (split out of tool.ts in G2-176): which saved session it
// is, its messages, title, mode and language. Held in memory and saved in
// the background (features/chat/store.ts explains why nothing the wearer
// waits on touches storage). A null id means "New chat" was picked and no
// question has been asked yet, so no session exists.

export type CurrentChat = {
  id: string | null
  messages: ChatMessage[]
  title: string | null
  // The chat's mode (G2-139, core/modes.ts): picked with a new-chat row,
  // kept with the chat, shown next to the model's name.
  mode: ModeId
  // A Code chat's language (G2-152).
  language: string | null
}

export const chat: CurrentChat = {
  id: null,
  messages: [],
  title: null,
  mode: 'auto',
  language: null,
}

// A blank chat in this mode (and language, for Code).
export function clearChat(mode: ModeId = 'auto', language: string | null = null): void {
  chat.id = null
  chat.messages = []
  chat.title = null
  chat.mode = mode
  chat.language = language
}

// Shows a saved session.
export function loadChat(session: ChatSession): void {
  chat.id = session.id
  chat.messages = session.messages
  chat.title = session.title
  chat.mode = modeOf(session.mode).id
  chat.language = session.language ?? null
}

// The chat as a session to save or list; null before its first question.
// The store keeps the mode and language it already has.
export function chatAsSession(now = Date.now()): ChatSession | null {
  if (chat.id === null) return null
  return { id: chat.id, title: chat.title ?? '(untitled)', messages: chat.messages, updatedAt: now }
}
