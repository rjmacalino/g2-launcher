// What every AI provider behind Jarvis shares (G2-68): the conversation
// shape, the options a request takes, the result, and the system prompt
// assembled from them. Gemini (core/gemini.ts), DeepSeek
// (core/deepseek.ts) and Claude (core/claude.ts) each turn these into
// their own wire format; core/llm.ts picks which one runs.

// Answers are read by paging on the glasses (features/chat/paging.ts), so
// they are full answers, not glance-length ones - per direct request. The
// wearer calls the assistant Jarvis and the model answers as Jarvis; the
// provider is only what is underneath.
export const CHAT_INSTRUCTION =
  'You are Jarvis, a conversational assistant on smart glasses with a ' +
  'small text display the wearer pages through. Answer fully and ' +
  'naturally, the way you would in any chat conversation - do not cut ' +
  'yourself short to save space. Finish your last sentence rather than ' +
  'trailing off. Plain text only, no markdown, no bullet lists. When the ' +
  'answer needs code, write it for a narrow screen: lines under 40 ' +
  'characters where possible, two-space indents, no code fences, the code ' +
  'first. Questions can be long, such as a whole programming problem: read ' +
  'all of it and follow its exact requirements, input and output, and ' +
  'examples, and make the code correct above all. The wearer is a junior web developer: prefer the simplest, most ' +
  'basic way to write it (plain loops and variables over clever one-liners ' +
  'or advanced features), and after the code explain it step by step in ' +
  'plain words, so they can explain it to someone else.'

// Answers used to be held at 400 tokens for one reason only: a single
// glasses update has a hard size ceiling (docs/platform.md), and anything
// longer got cut. Answers are paged now, so the display no longer limits
// their length - this is just a ceiling against a runaway reply eating
// quota or money: roughly 30,000 characters, many pages.
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192

// Function declarations are written once, in Gemini's format (upper-case
// type names, from the generateContent API reference) because that is the
// provider they were first built for; toJsonSchema converts them for the
// providers that take plain JSON Schema.
export type FunctionSchema = {
  type: 'STRING' | 'INTEGER' | 'NUMBER' | 'BOOLEAN' | 'ARRAY' | 'OBJECT'
  description?: string
  items?: FunctionSchema
  properties?: Record<string, FunctionSchema>
  required?: string[]
}

export type FunctionDeclaration = {
  name: string
  description: string
  parameters?: FunctionSchema
}

export type FunctionCall = { name: string; args: Record<string, unknown> }

// 'actions': the model chose to act rather than answer (see
// core/assistantActions.ts) - one or more calls, which the caller runs. Any
// text that came alongside them is dropped on purpose: the confirmation
// shown is written from what the action actually did, not from what the
// model expected it to do.
// A web page an answer drew on, when the AI searched (G2-76).
export type Source = { title: string; url: string }

export type LlmResult =
  // model: set only when a different model than the one asked answered
  // (Gemini's free-limit fallback, core/llm.ts).
  | { kind: 'answer'; text: string; sources?: Source[]; model?: string }
  | { kind: 'actions'; calls: FunctionCall[] }
  | { kind: 'error'; message: string }

// "model" rather than "assistant": Gemini's role name, kept because saved
// conversations (features/chat/store.ts) use it; the other providers map
// it to "assistant" on the way out.
export type LlmTurn = { role: 'user' | 'model'; text: string }

// The full conversation so far, oldest first, ending with the new question
// as the last 'user' turn - no provider remembers anything between
// requests, so every prior exchange is resent each time.
export type ConverseOptions = {
  // Called right before each retry attempt (never for the first try) with
  // the attempt about to start and the total allowed - Jarvis shows
  // "Retrying (2/3)" with it instead of an unchanging "Thinking...".
  onRetry?: (attempt: number, maxAttempts: number) => void
  // Extra context for the system instruction, from the caller - Jarvis
  // sends a short digest of the wearer's other recent conversations (see
  // features/chat/digest.ts). Built by the caller, not here, because it
  // comes from a feature's own data, and core/ never imports features/.
  background?: string
  // Actions the model may choose to call instead of answering (see
  // core/assistantActions.ts), plus a description of the wearer's data
  // they act on.
  functions?: readonly FunctionDeclaration[]
  actionContext?: string
  // When given, the reply is streamed and this is called with all the
  // answer text so far each time more arrives. Not called for a reply
  // that is function calls. The final result is still the return value.
  onText?: (textSoFar: string) => void
  // The wearer's "About You" text from the companion page. Passed in by
  // the caller rather than read from storage here, so the clients touch
  // nothing but the network: the PC benchmark (bench/) runs them outside
  // the WebView, with a test persona instead.
  aboutMe?: string | null
  // Replaces the chat instruction for a different job - Wingman's cues
  // (features/live/cues.ts) are one short line or nothing, not an answer.
  // About You and the background are still added after it.
  instruction?: string
  // The wearer's own standing brief, right after the instruction (G2-95,
  // core/localInstructions.ts) - like a CLAUDE.md.
  guide?: string
  maxOutputTokens?: number
  // How hard a model that reasons should think. Claude only today (its
  // output_config.effort); the others ignore it. Live's cues ask for
  // 'low' because a late cue is a useless cue.
  effort?: 'low' | 'medium' | 'high'
  // Let the AI search the web when a question needs it (G2-76): Google
  // Search grounding on Gemini, Anthropic's web search on Claude. DeepSeek
  // has no search of its own and ignores this. The model decides whether
  // to search; most questions do not need it.
  webSearch?: boolean
}

// Only added when there are functions to call. Function descriptions alone
// leave the edges to the model's guesswork; these are the ones that matter
// on a voice assistant: acting only when actually asked, what "remind me"
// can and cannot mean today, and not inventing a near-duplicate list.
const ACTIONS_INSTRUCTION =
  "You can act on the wearer's own checklists (notes) and their one " +
  'countdown timer with the functions provided. Call a function only when ' +
  'the wearer asks you to do that thing; a question about timers or lists ' +
  'in general is answered normally. "Remind me to X" means adding X to the ' +
  'list named Reminders - there are no timed reminders, so never promise ' +
  "one. When the wearer's words clearly mean one of their existing lists " +
  "(groceries for Shopping), use that list's exact name. A new list gets " +
  'a short title-case name without the word "list". Keep list items short. ' +
  'Several things asked at once are several function calls.'

// The system prompt every provider sends, from the same options.
export function buildSystemPrompt({
  instruction = CHAT_INSTRUCTION,
  guide,
  aboutMe,
  background,
  functions = [],
  actionContext,
}: ConverseOptions): string {
  // Per direct request: "I want my chatbot to know me... to tailor its
  // answer for me." Empty when nothing has been entered on the companion
  // page, which is the same as not having this feature at all.
  const parts = [instruction]
  if (guide) parts.push(guide)
  if (aboutMe) {
    parts.push(
      `Background on the person you're talking to - use it to tailor your answer naturally, without mentioning that you were told this: ${aboutMe}`,
    )
  }
  if (background) parts.push(background)
  if (functions.length > 0) {
    parts.push(ACTIONS_INSTRUCTION)
    if (actionContext) parts.push(actionContext)
  }
  return parts.join('\n\n')
}

export type JsonSchema = {
  type: string
  description?: string
  items?: JsonSchema
  properties?: Record<string, JsonSchema>
  required?: string[]
}

// Gemini's upper-case schema types to plain JSON Schema, for DeepSeek's and
// Claude's tool definitions. A function with no parameters still gets an
// empty object schema, which both accept.
export function toJsonSchema(schema: FunctionSchema | undefined): JsonSchema {
  if (!schema) return { type: 'object', properties: {} }
  const out: JsonSchema = { type: schema.type.toLowerCase() }
  if (schema.description) out.description = schema.description
  if (schema.items) out.items = toJsonSchema(schema.items)
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, toJsonSchema(value)]),
    )
  }
  if (schema.required) out.required = [...schema.required]
  return out
}

// Shared retry policy: up to 2 automatic retries (3 attempts) for failures
// that are plausibly transient - 503 (overloaded), 429 (rate limited), and
// a thrown fetch (a dropped connection). Any other status is returned at
// once: a bad request or a bad key will not fix itself on a second try.
export const MAX_ATTEMPTS = 3
export const RETRY_DELAY_MS = 1500

export function isTransient(status: number): boolean {
  return status === 503 || status === 429 || status === 529
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x)
}
