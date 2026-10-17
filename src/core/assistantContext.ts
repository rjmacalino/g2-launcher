// What Jarvis remembers about the wearer's other conversations, for any
// feature that talks to Gemini on their behalf - today Wingman's cues
// (features/live). The digest itself is built from Jarvis's saved chats
// (features/chat/digest.ts), and features never import each other, so
// app/main.ts registers the builder here at startup: the same indirection
// as core/voiceDispatch.ts and core/rebuild.ts.
let provider: (() => string) | null = null

export function registerConversationDigest(fn: () => string): void {
  provider = fn
}

// Empty when nothing is registered or there is nothing to say.
export function conversationDigest(): string {
  try {
    return provider?.() ?? ''
  } catch {
    return ''
  }
}

// Saving a conversation into Jarvis's history from another feature -
// Wingman's end-of-conversation record (features/live/summary.ts).
// Registered by app/main.ts, which knows Jarvis's store; same reason as
// the digest above.
export type SavedConversation = {
  title: string
  messages: { role: 'user' | 'model'; text: string; timestamp: number }[]
}

let saver: ((conversation: SavedConversation) => Promise<void>) | null = null

export function registerConversationSaver(
  fn: (conversation: SavedConversation) => Promise<void>,
): void {
  saver = fn
}

export async function saveConversation(conversation: SavedConversation): Promise<boolean> {
  if (!saver) return false
  await saver(conversation)
  return true
}
