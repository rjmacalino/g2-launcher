import type { ChatSession } from './store'

// The chat a long press on the glasses' chat list is about (G2-108): row 0
// is "New chat", rows after it are the saved chats in order. null for "New
// chat" or a row that is not there.
export function chatToDelete(row: number, sessions: readonly ChatSession[]): ChatSession | null {
  if (!Number.isInteger(row) || row < 1) return null
  return sessions[row - 1] ?? null
}

// The prompt: the chat's title, shortened to fit its one row.
export function deletePrompt(title: string): string {
  const flat = title.replace(/\s+/g, ' ').trim() || '(untitled)'
  const short = flat.length > 24 ? `${flat.slice(0, 21)}...` : flat
  return `Delete "${short}"?`
}
