// Jarvis's local commands. A recognized transcript may be a command
// (today Timer's structured commands - a later voice command for Notes or
// anything else would mean trying its own parser here too), and which
// feature a command belongs to is app-level knowledge. Same indirection as
// rebuild.ts's registerRebuildHandler: Jarvis (features/chat/tool.ts) does
// not import another feature directly (features/* modules never import
// each other - only app/* crosses feature boundaries), so app/main.ts
// registers the real handler here at startup and Jarvis calls through it.
// Anything not handled here, Jarvis sends to Gemini itself.
//
// Async so a future command can do I/O; today's are all local.
export type VoiceDispatchResult = { handled: true; message: string } | { handled: false }

let handler: ((transcript: string) => Promise<VoiceDispatchResult>) | null = null

export function registerVoiceDispatch(fn: (transcript: string) => Promise<VoiceDispatchResult>) {
  handler = fn
}

export async function dispatchVoiceCommand(transcript: string): Promise<VoiceDispatchResult> {
  return (await handler?.(transcript)) ?? { handled: false }
}
