// What Jarvis remembers about the wearer's other conversations, for any
// feature that talks to Gemini on their behalf - today Jarvis Live's cues
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
