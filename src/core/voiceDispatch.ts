// A recognized transcript needs to be turned into an action, but which
// feature that action belongs to is app-level knowledge (today only Timer;
// a later voice command for Notes or anything else would mean trying more
// than one parser). Same indirection as rebuild.ts's registerRebuildHandler:
// features/jarvis does not import another feature directly (this codebase's
// features/* modules never import each other - only app/* is allowed to
// cross feature boundaries), so app/main.ts registers the real handler here
// at startup and features/jarvis/tool.ts calls through it.
export type VoiceDispatchResult = { handled: true; message: string } | { handled: false }

let handler: ((transcript: string) => VoiceDispatchResult) | null = null

export function registerVoiceDispatch(fn: (transcript: string) => VoiceDispatchResult) {
  handler = fn
}

export function dispatchVoiceCommand(transcript: string): VoiceDispatchResult {
  return handler?.(transcript) ?? { handled: false }
}
