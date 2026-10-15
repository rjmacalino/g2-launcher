import type { FunctionCall, FunctionDeclaration } from './gemini'

// Things Jarvis can DO, not just answer: add to a list, start or cancel a
// timer. Per direct request, Jarvis is meant to be one assistant for both
// ("an alexa + gemini combine"), and the notes and timer live in features
// Jarvis is not allowed to import (features/* never import each other).
// Same indirection as core/voiceDispatch.ts: each feature describes its own
// actions, app/main.ts registers them here at startup, and Jarvis
// (features/chat/tool.ts) offers them to Gemini and runs what comes back.
//
// Gemini only ever DECIDES which action to take - it answers with a
// structured function call instead of text (Gemini's "function calling").
// The action itself runs here on the phone, and its confirmation ("Added
// eggs to Shopping.") is written by our own code from what actually
// happened, never by the model. A model writing its own confirmation could
// claim something was done that was not.
export type AssistantAction = {
  declaration: FunctionDeclaration
  // Returns the sentence shown to the wearer. Never throws on a request it
  // cannot carry out ("no list called X") - that is a normal reply to show,
  // not an error.
  run: (args: Record<string, unknown>) => Promise<string>
}

export type AssistantActionSet = {
  actions: readonly AssistantAction[]
  // A short description of the wearer's current data for Gemini's system
  // instruction - today the names of their lists, so "groceries" can be
  // matched to an existing list called "Shopping" instead of starting a
  // second one. Optional, and best effort: see ACTION_CONTEXT_TIMEOUT_MS.
  context?: () => Promise<string>
}

let registered: AssistantActionSet | null = null

export function registerAssistantActions(set: AssistantActionSet): void {
  registered = set
}

export function assistantActions(): readonly AssistantAction[] {
  return registered?.actions ?? []
}

// The context comes from a storage read, and host storage reads have hung
// before with no error at all (see platform/storage.ts and
// features/chat/store.ts). A question is never held up waiting for it:
// past this, Gemini just gets no context, which costs it list-name hints
// and nothing else.
const ACTION_CONTEXT_TIMEOUT_MS = 1500

export async function assistantActionContext(): Promise<string> {
  const context = registered?.context
  if (!context) return ''
  return Promise.race([
    context().catch(() => ''),
    new Promise<string>(resolve => setTimeout(() => resolve(''), ACTION_CONTEXT_TIMEOUT_MS)),
  ])
}

// Same reason as the context timeout above: every action reads or writes
// storage, and an action that never settles would leave Jarvis on
// "Thinking" for good.
const ACTION_RUN_TIMEOUT_MS = 8000

async function runOne(call: FunctionCall): Promise<string> {
  const action = assistantActions().find(a => a.declaration.name === call.name)
  // Gemini only ever sees the declarations registered here, so this would
  // mean a model mistake - reported plainly rather than silently ignored.
  if (!action) return `I don't know how to do "${call.name}" yet.`
  try {
    return await Promise.race([
      action.run(call.args),
      new Promise<string>(resolve =>
        setTimeout(
          () => resolve(`That took too long and may not have finished (${call.name}).`),
          ACTION_RUN_TIMEOUT_MS,
        ),
      ),
    ])
  } catch (e) {
    return `That failed (${e instanceof Error ? e.message : String(e)}).`
  }
}

// One after another, never in parallel, so two changes to the same list
// cannot overlap. The replies are joined into the one message the wearer
// sees.
export async function runAssistantActions(calls: readonly FunctionCall[]): Promise<string> {
  const replies: string[] = []
  for (const call of calls) replies.push(await runOne(call))
  return replies.join('\n')
}
