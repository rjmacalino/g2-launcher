// A cloud LLM, used only when a transcript does not match any local
// command parser (see core/voiceDispatch.ts) - the fallback that makes
// Jarvis able to actually answer a question instead of just running
// commands. Deliberately not the default path for everything: local parsing
// costs nothing and has no dependency on an API key or network, and per
// docs/roadmap.md decision D1 this only exists because open-ended questions
// need real language understanding no on-device model here is a good match
// for.
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
const MODEL = 'gemini-3.8-flash'
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`

// Kept short on purpose: this answers a question relayed through a
// push-to-talk voice command, read once off a tiny glasses display, not a
// long-form chat. A short system instruction steers the model toward that
// without spending a reply's worth of tokens on something too long to be
// useful here anyway.
const SYSTEM_INSTRUCTION =
  'You are a voice assistant on smart glasses with a small display. ' +
  'Answer in one or two short sentences, plain text, no markdown, no lists.'

export type GeminiResult = { kind: 'answer'; text: string } | { kind: 'error'; message: string }

// One retry, specifically for a 503 - seen twice in a row testing this
// against the real API with a real key, and Google's own error text calls
// it "usually temporary". Not retried for any other status: a bad request
// or an auth failure will not fix itself on a second try, so retrying those
// would only cost the wearer more waiting for the same result.
const RETRY_DELAY_MS = 1500

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function requestOnce(apiKey: string, question: string): Promise<Response> {
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: question }] }],
      systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
      generationConfig: { maxOutputTokens: 120 },
    }),
  })
}

export async function ask(apiKey: string, question: string): Promise<GeminiResult> {
  try {
    let response = await requestOnce(apiKey, question)
    if (response.status === 503) {
      await delay(RETRY_DELAY_MS)
      response = await requestOnce(apiKey, question)
    }
    if (!response.ok) {
      return { kind: 'error', message: `Gemini returned ${response.status}` }
    }
    const data: unknown = await response.json()
    const text = extractText(data)
    if (!text) return { kind: 'error', message: 'empty response' }
    return { kind: 'answer', text }
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) }
  }
}

// Reaches into candidates[0].content.parts[0].text without trusting the
// exact shape - this is a third-party API response, not our own data, so
// every step is guarded rather than assumed.
function extractText(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const candidates = (data as Record<string, unknown>).candidates
  if (!Array.isArray(candidates) || candidates.length === 0) return null
  const first = candidates[0]
  if (!first || typeof first !== 'object') return null
  const content = (first as Record<string, unknown>).content
  if (!content || typeof content !== 'object') return null
  const parts = (content as Record<string, unknown>).parts
  if (!Array.isArray(parts) || parts.length === 0) return null
  const part = parts[0]
  if (!part || typeof part !== 'object') return null
  const text = (part as Record<string, unknown>).text
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  return trimmed.length > 0 ? trimmed : null
}
