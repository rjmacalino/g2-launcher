import { getAboutMe } from './geminiSettings'

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

// Jarvis's fallback is read once, off a push-to-talk voice command, with no
// scrolling built for it - so its answers stay short on purpose. Chat is a
// real multi-turn conversation with its own scrollable history (see
// features/chat/tool.ts), so it gets the opposite instruction: answer fully,
// let the wearer scroll, same as any chat app would. Per docs/platform.md,
// a text container cannot shrink its own font - "scroll more" is the only
// knob here, not "show smaller text".
const SYSTEM_INSTRUCTION_CONCISE =
  'You are a voice assistant on smart glasses with a small display. ' +
  'Answer in one or two short sentences, plain text, no markdown, no lists.'

const SYSTEM_INSTRUCTION_FULL =
  'You are a conversational assistant on smart glasses with a small text ' +
  'display the wearer pages through. Answer fully and naturally, the way ' +
  'you would in any chat conversation - do not cut yourself short to save ' +
  'space. Finish your last sentence rather than trailing off. Plain text ' +
  'only, no markdown, no bullet lists.'

// Jarvis's cap keeps a glance-read answer from running past what a single
// unscrolled screen can show. Chat's used to be held at 400 tokens for one
// reason only: a single glasses update has a hard size ceiling
// (docs/platform.md), and anything longer got cut. features/chat/tool.ts
// now splits an answer into one-screen pages instead, so the display no
// longer limits answer length at all - per direct request, the full answer,
// never cut. This cap is just a ceiling against a runaway reply eating the
// free tier's quota: roughly 4,000 characters, several pages.
const MAX_OUTPUT_TOKENS_CONCISE = 120
const MAX_OUTPUT_TOKENS_FULL = 1024

export type GeminiResult = { kind: 'answer'; text: string } | { kind: 'error'; message: string }

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
  concise: boolean,
  systemInstruction: string,
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
      generationConfig: {
        maxOutputTokens: concise ? MAX_OUTPUT_TOKENS_CONCISE : MAX_OUTPUT_TOKENS_FULL,
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
// every prior exchange has to be resent each time. Used by both Jarvis
// (a single-turn conversation, see ask() below) and Chat (a real multi-turn
// one, see features/chat/tool.ts).
//
// concise defaults to true (Jarvis's own need) so ask() below needs no
// change; Chat passes false explicitly. onRetry, when given, is called
// right before each retry attempt (never for the first try) with the
// attempt number about to start and the total attempts allowed - Chat
// uses this to show "retrying (2/3)" instead of leaving the wearer
// looking at an unchanging "Thinking..." through what might be several
// seconds of silent retries (see features/chat/tool.ts).
export async function converse(
  apiKey: string,
  turns: readonly GeminiTurn[],
  concise = true,
  onRetry?: (attempt: number, maxAttempts: number) => void,
): Promise<GeminiResult> {
  // Folded in here, once, rather than left to each caller - both Jarvis
  // and Chat should tailor answers to the same person, and this is the
  // one place every request already passes through. Per direct request:
  // "I want my chatbot to know me... to tailor its answer for me." Empty
  // when nothing has been entered on the companion page, which is the
  // same as not having this feature at all.
  const aboutMe = await getAboutMe()
  const baseInstruction = concise ? SYSTEM_INSTRUCTION_CONCISE : SYSTEM_INSTRUCTION_FULL
  const systemInstruction = aboutMe
    ? `${baseInstruction}\n\nBackground on the person you're talking to - use it to tailor your answer naturally, without mentioning that you were told this: ${aboutMe}`
    : baseInstruction

  let lastErrorMessage = 'unknown error'
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      onRetry?.(attempt, MAX_ATTEMPTS)
      await delay(RETRY_DELAY_MS)
    }
    try {
      const response = await requestOnce(apiKey, turns, concise, systemInstruction)
      if (!response.ok) {
        lastErrorMessage = `Gemini returned ${response.status}`
        if (isTransient(response.status) && attempt < MAX_ATTEMPTS) continue
        return { kind: 'error', message: lastErrorMessage }
      }
      const data: unknown = await response.json()
      const text = extractText(data)
      if (!text) return { kind: 'error', message: 'empty response' }
      return { kind: 'answer', text }
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

// A single question, no history - what Jarvis's one-shot command fallback
// needs (see core/voiceDispatch.ts). A thin wrapper over converse() rather
// than a separate request shape, so the two never drift apart.
export function ask(apiKey: string, question: string): Promise<GeminiResult> {
  return converse(apiKey, [{ role: 'user', text: question }])
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
