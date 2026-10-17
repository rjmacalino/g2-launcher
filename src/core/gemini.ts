// The model behind Jarvis's answers: anything Jarvis hears that is not a
// local command (see core/voiceDispatch.ts) comes here, as part of the
// conversation it was asked in. Deliberately not the path for commands:
// local parsing costs nothing and has no dependency on an API key or
// network, and per docs/roadmap.md decision D1 this only exists because
// open-ended questions need real language understanding no on-device model
// here is a good match for.
//
// Chose Gemini's free tier over a cheap paid one (DeepSeek, also confirmed
// working) per direct request to look for free options first. Real
// tradeoff worth knowing: Google's free tier terms say content sent may be
// used to improve their products - relevant here specifically because this
// can end up sending speech from whoever the wearer is talking to, not only
// the wearer's own words.
//
// Confirmed by a real request (not just documentation, which turned out to
// describe the wrong endpoint shape when checked against the live API)
// before writing this: the generateContent endpoint answers CORS
// preflights with an access-control-allow-origin that echoes the request's
// own Origin, so this can call it directly from the WebView - no backend
// proxy needed.
// gemini-2.5-flash, the model this originally shipped with, turned out to
// be retired for new API keys [confirmed against the live API with a real
// key, not documentation] - Google's own error names gemini-3.8-flash as
// its replacement, and a request against it gets past model validation
// (hit a transient 503 "high demand" on the two tries made here, a Google
// capacity issue, not a request problem).
export const GEMINI_MODEL = 'gemini-3.8-flash'
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`

// Answers are read by paging on the glasses (features/chat/paging.ts), so
// they are full answers, not glance-length ones - per direct request. The
// wearer calls the assistant Jarvis and the model answers as Jarvis; Gemini
// is only what is underneath.
const SYSTEM_INSTRUCTION =
  'You are Jarvis, a conversational assistant on smart glasses with a ' +
  'small text display the wearer pages through. Answer fully and ' +
  'naturally, the way you would in any chat conversation - do not cut ' +
  'yourself short to save space. Finish your last sentence rather than ' +
  'trailing off. Plain text only, no markdown, no bullet lists.'

// Answers used to be held at 400 tokens for one reason only: a single
// glasses update has a hard size ceiling (docs/platform.md), and anything
// longer got cut. Answers are paged now, so the display no longer limits
// their length - this is just a ceiling against a runaway reply eating the
// free tier's quota: roughly 4,000 characters, several pages.
const MAX_OUTPUT_TOKENS = 1024

// Function calling, in Gemini's own wire format (checked against the
// generateContent API reference at ai.google.dev/api/generate-content, not
// the function-calling guide, which now documents a different endpoint):
// declarations go in the request as tools[].functionDeclarations, each
// parameter schema's type is one of the reference's upper-case Type values,
// and a call comes back as a part holding functionCall { name, args }
// instead of text.
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

// 'actions': Gemini chose to act rather than answer (see
// core/assistantActions.ts) - one or more calls, which the caller runs. Any
// text that came alongside them is dropped on purpose: the confirmation
// shown is written from what the action actually did, not from what the
// model expected it to do.
export type GeminiResult =
  | { kind: 'answer'; text: string }
  | { kind: 'actions'; calls: FunctionCall[] }
  | { kind: 'error'; message: string }

// Gemini's own role names, not ours to invent - "model" rather than the more
// common "assistant" seen elsewhere, which is why features/chat/store.ts
// stores messages with this exact union rather than a generic one, so a
// stored conversation can be replayed straight into a request with no
// translation step.
export type GeminiTurn = { role: 'user' | 'model'; text: string }

// Up to 2 automatic retries (3 attempts total) for failures that are
// plausibly transient: 503 (Google's own error text calls it "usually
// temporary", seen twice in a row testing this against the real API), 429
// (rate limit - the same request will often just work a moment later),
// and a thrown fetch exception (a dropped connection, not a response at
// all). NOT retried: any other HTTP status - a bad request or an auth
// failure will not fix itself on a second try, so retrying those would
// only cost the wearer more waiting for the same result they already got.
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 1500

function isTransient(status: number): boolean {
  return status === 503 || status === 429
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function requestOnce(
  apiKey: string,
  turns: readonly GeminiTurn[],
  systemInstruction: string,
  functions: readonly FunctionDeclaration[],
): Promise<Response> {
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: turns.map(turn => ({ role: turn.role, parts: [{ text: turn.text }] })),
      systemInstruction: {
        parts: [{ text: systemInstruction }],
      },
      // No toolConfig: the reference's default mode is AUTO, "the model
      // chooses between a function call or a natural language response",
      // which is exactly the behaviour wanted - a question gets an answer,
      // a request gets an action.
      ...(functions.length > 0 ? { tools: [{ functionDeclarations: functions }] } : {}),
      generationConfig: {
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        // gemini-3.8-flash "thinks" before answering, and that thinking
        // spends tokens out of the SAME maxOutputTokens budget as the
        // visible reply - confirmed by symptom, not by a doc or a test with
        // a real key: raising the cap from 120 to 350 should have produced
        // several real sentences, but answers kept coming back only ~10
        // words long everywhere, including the companion page, which has no
        // display-side limit at all to blame instead. That only makes sense
        // if most of the 350-token budget was being spent on invisible
        // thinking tokens before the model got to the actual answer text.
        // thinkingBudget: 0 turns thinking off - a short conversational
        // reply has no real use for it anyway - so the whole cap goes to
        // text that actually gets shown. Needs a real-key check to confirm,
        // same as every other Gemini behaviour here that was not just taken
        // from documentation.
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  })
}

// The full conversation so far (see GeminiTurn above), oldest first, ending
// with the new question as the last 'user' turn - this is what makes a
// follow-up a follow-up: Gemini has no memory of its own between requests,
// every prior exchange has to be resent each time (see
// features/chat/tool.ts).
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
  // Actions Gemini may choose to call instead of answering (see
  // core/assistantActions.ts), plus a description of the wearer's data
  // they act on.
  functions?: readonly FunctionDeclaration[]
  actionContext?: string
  // The wearer's "About You" text from the companion page. Passed in by
  // the caller rather than read from storage here, so this module touches
  // nothing but the network: the PC benchmark (bench/) runs this exact
  // client and prompt outside the WebView, with a test persona instead.
  aboutMe?: string | null
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

export async function converse(
  apiKey: string,
  turns: readonly GeminiTurn[],
  { onRetry, background, functions = [], actionContext, aboutMe }: ConverseOptions = {},
): Promise<GeminiResult> {
  // Per direct request: "I want my chatbot to know me... to tailor its
  // answer for me." Empty when nothing has been entered on the companion
  // page, which is the same as not having this feature at all.
  const parts = [SYSTEM_INSTRUCTION]
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
  const systemInstruction = parts.join('\n\n')

  let lastErrorMessage = 'unknown error'
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      onRetry?.(attempt, MAX_ATTEMPTS)
      await delay(RETRY_DELAY_MS)
    }
    try {
      const response = await requestOnce(apiKey, turns, systemInstruction, functions)
      if (!response.ok) {
        lastErrorMessage = `Gemini returned ${response.status}`
        if (isTransient(response.status) && attempt < MAX_ATTEMPTS) continue
        return { kind: 'error', message: lastErrorMessage }
      }
      const data: unknown = await response.json()
      return parseReply(data)
    } catch (e) {
      lastErrorMessage = e instanceof Error ? e.message : String(e)
      if (attempt < MAX_ATTEMPTS) continue
      return { kind: 'error', message: lastErrorMessage }
    }
  }
  // Unreachable - the loop always returns on its final attempt - but kept
  // so this has an explicit return for every path rather than relying on
  // that being obvious from the loop bounds alone.
  return { kind: 'error', message: lastErrorMessage }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x)
}

// Reads candidates[0].content.parts without trusting the exact shape - this
// is a third-party API response, not our own data, so every step is guarded
// rather than assumed. Every part is read, not just the first: a reply can
// be several function calls (one per thing asked for), and text can arrive
// split across parts. Parts marked thought: true are the model's own
// reasoning, not reply text - none are expected with thinking turned off
// above, but they must never be shown as the answer if they appear.
// Exported for tests.
export function parseReply(data: unknown): GeminiResult {
  const empty: GeminiResult = { kind: 'error', message: 'empty response' }
  if (!isRecord(data)) return empty
  const candidates = data.candidates
  if (!Array.isArray(candidates) || candidates.length === 0) return empty
  const first: unknown = candidates[0]
  if (!isRecord(first) || !isRecord(first.content)) return empty
  const parts = first.content.parts
  if (!Array.isArray(parts)) return empty

  const calls: FunctionCall[] = []
  const texts: string[] = []
  for (const part of parts) {
    if (!isRecord(part)) continue
    const call = part.functionCall
    if (isRecord(call) && typeof call.name === 'string') {
      calls.push({ name: call.name, args: isRecord(call.args) ? call.args : {} })
      continue
    }
    if (part.thought === true) continue
    if (typeof part.text === 'string') texts.push(part.text)
  }
  if (calls.length > 0) return { kind: 'actions', calls }
  const text = texts.join('').trim()
  return text.length > 0 ? { kind: 'answer', text } : empty
}
