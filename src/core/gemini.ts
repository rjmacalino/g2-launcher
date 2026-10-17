import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_ATTEMPTS,
  RETRY_DELAY_MS,
  buildSystemPrompt,
  delay,
  isRecord,
  isTransient,
  type ConverseOptions,
  type FunctionCall,
  type FunctionDeclaration,
  type FunctionSchema,
  type LlmResult,
  type Source,
  type LlmTurn,
} from './llmTypes'
import { parseSseEvents } from '../shared/sse'

// Kept exported from here for older imports (tests, bench).
export { parseSseEvents }

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

// The provider-neutral types, under the names the rest of the app has
// always imported from here.
export type GeminiResult = LlmResult
export type GeminiTurn = LlmTurn
export type { ConverseOptions, FunctionCall, FunctionDeclaration, FunctionSchema }

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
  webSearch: boolean,
): string {
  const tools = [
    ...(functions.length > 0 ? [{ functionDeclarations: functions }] : []),
    // Google Search grounding (G2-76), the Tool field from the
    // generateContent reference. Google's grounding guide says Gemini 3
    // models can use it alongside function calling; if this endpoint
    // refuses the pair anyway, converse() drops search (searchRefused).
    ...(webSearch ? [{ googleSearch: {} }] : []),
  ]
  return JSON.stringify({
    contents: turns.map(turn => ({ role: turn.role, parts: [{ text: turn.text }] })),
    systemInstruction: {
      parts: [{ text: systemInstruction }],
    },
    // No toolConfig: the reference's default mode is AUTO, "the model
    // chooses between a function call or a natural language response",
    // which is exactly the behaviour wanted - a question gets an answer,
    // a request gets an action.
    ...(tools.length > 0 ? { tools } : {}),
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

// Set the first time a streamed request fails where the same request
// without streaming then works: streaming itself is what does not work
// here (the WebView, a proxy, the endpoint), so later questions skip
// straight to the request known to work instead of failing first each time.
let streamingBroken = false

// Set when Gemini refuses a request because of the search tool: later
// questions go without it instead of failing first every time.
let searchRefused = false

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
  options: ConverseOptions = {},
): Promise<GeminiResult> {
  const { onRetry, functions = [], onText, maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS } = options
  let search = options.webSearch === true && !searchRefused
  const build = () =>
    requestBody(turns, buildSystemPrompt(options), functions, maxOutputTokens, search)
  let body = build()

  let lastErrorMessage = 'unknown error'
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      onRetry?.(attempt, MAX_ATTEMPTS)
      await delay(RETRY_DELAY_MS)
    }
    try {
      const result = await attemptOnce(apiKey, body, onText)
      if (result.kind === 'http') {
        // A bad request with search on: most likely search is what this
        // model or key will not take. Ask again without it, and stop
        // offering it for the rest of the session.
        if (result.status === 400 && search) {
          searchRefused = true
          search = false
          body = build()
          attempt--
          continue
        }
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
  // Search sources arrive on one of the chunks, usually the last.
  let groundingMetadata: unknown
  for (const chunk of chunks) {
    if (!isRecord(chunk) || !Array.isArray(chunk.candidates)) continue
    const candidate: unknown = chunk.candidates[0]
    if (isRecord(candidate) && isRecord(candidate.groundingMetadata)) {
      groundingMetadata = candidate.groundingMetadata
    }
  }
  return {
    candidates: [
      {
        content: { parts: chunks.flatMap(partsOf) },
        ...(groundingMetadata ? { groundingMetadata } : {}),
      },
    ],
  }
}

// The pages a searched answer drew on: groundingMetadata.groundingChunks
// with web { uri, title }, at most three, one per title.
function sourcesOf(candidate: Record<string, unknown>): Source[] {
  const metadata = candidate.groundingMetadata
  if (!isRecord(metadata) || !Array.isArray(metadata.groundingChunks)) return []
  const sources: Source[] = []
  for (const chunk of metadata.groundingChunks) {
    if (!isRecord(chunk) || !isRecord(chunk.web)) continue
    const { uri, title } = chunk.web
    if (typeof uri !== 'string') continue
    const name = typeof title === 'string' && title ? title : uri
    if (sources.some(s => s.title === name)) continue
    sources.push({ title: name, url: uri })
    if (sources.length === 3) break
  }
  return sources
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
  if (text.length === 0) return empty
  const sources = sourcesOf(first)
  return sources.length > 0 ? { kind: 'answer', text, sources } : { kind: 'answer', text }
}
