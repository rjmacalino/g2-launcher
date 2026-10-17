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
// The same request, answered as a stream of partial replies (G2-62), so the
// first words reach the glasses while the rest is still being written.
// Endpoint and alt=sse are from the API reference (ai.google.dev/api/
// generate-content), which says the body is "a stream of
// GenerateContentResponse instances" but does not spell out the framing;
// alt=sse is read as server-sent events (data: lines), and anything that
// does not parse falls back to the non-streaming request (see converse).
// [UNVERIFIED with a real key, and its CORS behaviour from the WebView is
// unchecked - generateContent's was confirmed, this one's was not.]
const STREAM_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`

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

function requestOnce(apiKey: string, url: string, body: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body,
  })
}

function requestBody(
  turns: readonly GeminiTurn[],
  systemInstruction: string,
  functions: readonly FunctionDeclaration[],
  maxOutputTokens: number,
): string {
  return JSON.stringify({
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
      maxOutputTokens,
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
  // When given, the reply is streamed and this is called with all the
  // answer text so far each time more arrives. Not called for a reply
  // that is function calls. The final result is still the return value.
  onText?: (textSoFar: string) => void
  // The wearer's "About You" text from the companion page. Passed in by
  // the caller rather than read from storage here, so this module touches
  // nothing but the network: the PC benchmark (bench/) runs this exact
  // client and prompt outside the WebView, with a test persona instead.
  aboutMe?: string | null
  // Replaces Jarvis's chat instruction for a different job - Jarvis Live's
  // cues (features/live/cues.ts) are one short line or nothing, not an
  // answer. About You and the background are still added after it.
  instruction?: string
  maxOutputTokens?: number
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

// Set the first time a streamed request fails where the same request
// without streaming then works: streaming itself is what does not work
// here (the WebView, a proxy, the endpoint), so later questions skip
// straight to the request known to work instead of failing first each time.
let streamingBroken = false

type Attempt = { kind: 'reply'; data: unknown } | { kind: 'http'; status: number }

async function attemptPlain(apiKey: string, body: string): Promise<Attempt> {
  const response = await requestOnce(apiKey, ENDPOINT, body)
  if (!response.ok) return { kind: 'http', status: response.status }
  return { kind: 'reply', data: await response.json() }
}

// Resolves to null when the stream answered but yielded nothing readable,
// so the caller can retry without streaming.
async function attemptStreamed(
  apiKey: string,
  body: string,
  onText: (textSoFar: string) => void,
): Promise<Attempt | null> {
  const response = await requestOnce(apiKey, STREAM_ENDPOINT, body)
  if (!response.ok) return { kind: 'http', status: response.status }
  if (!response.body) return null
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: unknown[] = []
  let buffer = ''
  let text = ''
  const take = (payloads: readonly string[]) => {
    for (const payload of payloads) {
      let chunk: unknown
      try {
        chunk = JSON.parse(payload)
      } catch {
        continue
      }
      chunks.push(chunk)
      const more = chunkText(chunk)
      if (more) {
        text += more
        onText(text)
      }
    }
  }
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const parsed = parseSseEvents(buffer + decoder.decode(value, { stream: true }))
    buffer = parsed.rest
    take(parsed.events)
  }
  take(parseSseEvents(`${buffer}${decoder.decode()}\n\n`).events)
  return chunks.length > 0 ? { kind: 'reply', data: mergeStreamChunks(chunks) } : null
}

// One try: streamed when asked for and not known to be broken, falling
// back to the plain request when the stream fails in a way the plain
// request might not (no response at all, unreadable, or a refusal that is
// not a transient overload).
async function attemptOnce(
  apiKey: string,
  body: string,
  onText: ((textSoFar: string) => void) | undefined,
): Promise<Attempt> {
  if (!onText || streamingBroken) return attemptPlain(apiKey, body)
  let streamed: Attempt | null
  try {
    streamed = await attemptStreamed(apiKey, body, onText)
  } catch {
    streamed = null
  }
  if (streamed && (streamed.kind === 'reply' || isTransient(streamed.status))) return streamed
  const plain = await attemptPlain(apiKey, body)
  if (plain.kind === 'reply') streamingBroken = true
  return plain
}

export async function converse(
  apiKey: string,
  turns: readonly GeminiTurn[],
  {
    onRetry,
    background,
    functions = [],
    actionContext,
    aboutMe,
    onText,
    instruction = SYSTEM_INSTRUCTION,
    maxOutputTokens = MAX_OUTPUT_TOKENS,
  }: ConverseOptions = {},
): Promise<GeminiResult> {
  // Per direct request: "I want my chatbot to know me... to tailor its
  // answer for me." Empty when nothing has been entered on the companion
  // page, which is the same as not having this feature at all.
  const parts = [instruction]
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
  const body = requestBody(turns, parts.join('\n\n'), functions, maxOutputTokens)

  let lastErrorMessage = 'unknown error'
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      onRetry?.(attempt, MAX_ATTEMPTS)
      await delay(RETRY_DELAY_MS)
    }
    try {
      const result = await attemptOnce(apiKey, body, onText)
      if (result.kind === 'http') {
        lastErrorMessage = `Gemini returned ${result.status}`
        if (isTransient(result.status) && attempt < MAX_ATTEMPTS) continue
        return { kind: 'error', message: lastErrorMessage }
      }
      return parseReply(result.data)
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

// Server-sent events: events end with a blank line, and an event's payload
// is its "data:" lines joined. Returns the complete events in buffer and
// the unfinished remainder to prepend to the next piece of the stream.
// Exported for tests.
export function parseSseEvents(buffer: string): { events: string[]; rest: string } {
  const blocks = buffer.replace(/\r\n?/g, '\n').split('\n\n')
  const rest = blocks.pop() ?? ''
  const events: string[] = []
  for (const block of blocks) {
    const data = block
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (data && data !== '[DONE]') events.push(data)
  }
  return { events, rest }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x)
}

function partsOf(chunk: unknown): unknown[] {
  if (!isRecord(chunk) || !Array.isArray(chunk.candidates)) return []
  const first: unknown = chunk.candidates[0]
  if (!isRecord(first) || !isRecord(first.content) || !Array.isArray(first.content.parts)) {
    return []
  }
  return first.content.parts
}

// The answer text in one streamed chunk, skipping thought parts the same
// way parseReply does.
function chunkText(chunk: unknown): string {
  return partsOf(chunk)
    .map(part =>
      isRecord(part) && part.thought !== true && typeof part.text === 'string' ? part.text : '',
    )
    .join('')
}

// Every streamed chunk's parts in order, as one response parseReply can
// read - so a streamed reply ends in exactly the same result as a plain
// one, function calls included. Exported for tests.
export function mergeStreamChunks(chunks: readonly unknown[]): unknown {
  return { candidates: [{ content: { parts: chunks.flatMap(partsOf) } }] }
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
