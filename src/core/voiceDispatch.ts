// A recognized transcript needs to be turned into an action, but which
// feature that action belongs to is app-level knowledge (today Timer's
// structured commands, then a Gemini fallback for anything else - a later
// voice command for Notes or anything else would mean trying its own parser
// here too). Same indirection as rebuild.ts's registerRebuildHandler:
// features/jarvis does not import another feature directly (this codebase's
// features/* modules never import each other - only app/* is allowed to
// cross feature boundaries), so app/main.ts registers the real handler here
// at startup and features/jarvis/tool.ts calls through it.
//
// Async because the Gemini fallback is a network call - was a plain
// synchronous function before that existed, when every handler was a local
// parser with nothing to await.
export type VoiceDispatchResult = { handled: true; message: string } | { handled: false }

let handler: ((transcript: string) => Promise<VoiceDispatchResult>) | null = null

export function registerVoiceDispatch(fn: (transcript: string) => Promise<VoiceDispatchResult>) {
  handler = fn
}

export async function dispatchVoiceCommand(transcript: string): Promise<VoiceDispatchResult> {
  return (await handler?.(transcript)) ?? { handled: false }
}
