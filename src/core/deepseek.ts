import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_ATTEMPTS,
  RETRY_DELAY_MS,
  buildSystemPrompt,
  delay,
  isRecord,
  isTransient,
  toJsonSchema,
  type ConverseOptions,
  type FunctionCall,
  type LlmResult,
  type LlmTurn,
} from './llmTypes'
import { readSseStream } from '../shared/sse'

// DeepSeek as Jarvis's model (G2-68), a paid option next to Gemini's free
// tier. Plain HTTP against its OpenAI-compatible endpoint, checked against
// DeepSeek's own API reference (api-docs.deepseek.com, read 2026-10-17):
// POST https://api.deepseek.com/chat/completions with a Bearer key;
// messages with system/user/assistant roles; tools as
// { type: "function", function: { name, description, parameters } };
// tool calls come back in message.tool_calls with arguments as a JSON
// string, and in a stream as delta.tool_calls pieces keyed by index, the
// first piece carrying id and name. The endpoint answers CORS preflights
// with the page's own origin (checked with a real preflight), so the
// WebView can call it directly, the same as Gemini.
//
// Thinking is switched off: it is on by default, adds a pause before the
// first word that a voice assistant cannot afford, and with tools in the
// request it requires the reasoning text to be sent back on every later
// turn, which Jarvis's stored conversations do not keep.
const ENDPOINT = 'https://api.deepseek.com/chat/completions'

export const DEEPSEEK_MODELS = ['deepseek-flash', 'deepseek-v4-pro'] as const

type ToolCallPiece = { id?: string; name: string; arguments: string }

function requestBody(
  model: string,
  turns: readonly LlmTurn[],
  options: ConverseOptions,
  stream: boolean,
): string {
  const functions = options.functions ?? []
  return JSON.stringify({
    model,
    messages: [
      { role: 'system', content: buildSystemPrompt(options) },
      ...turns.map(turn => ({
        role: turn.role === 'model' ? 'assistant' : 'user',
        content: turn.text,
      })),
    ],
    max_tokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    stream,
    thinking: { type: 'disabled' },
    ...(functions.length > 0
      ? {
          tools: functions.map(f => ({
            type: 'function',
            function: {
              name: f.name,
              description: f.description,
              parameters: toJsonSchema(f.parameters),
            },
          })),
        }
      : {}),
  })
}

// A model's arguments string to an object; a call whose arguments do not
// parse is dropped rather than run with nothing.
function toCall(piece: ToolCallPiece): FunctionCall | null {
  if (!piece.name) return null
  if (!piece.arguments.trim()) return { name: piece.name, args: {} }
  try {
    const args: unknown = JSON.parse(piece.arguments)
    return isRecord(args) ? { name: piece.name, args } : null
  } catch {
    return null
  }
}

function finish(text: string, pieces: ToolCallPiece[], finishReason: string | null): LlmResult {
  const calls = pieces.map(toCall).filter((c): c is FunctionCall => c !== null)
  if (calls.length > 0) {
    // Cut off mid-arguments: never run a half-written call.
    if (finishReason === 'length') return { kind: 'error', message: 'reply cut off' }
    return { kind: 'actions', calls }
  }
  const answer = text.trim()
  return answer ? { kind: 'answer', text: answer } : { kind: 'error', message: 'empty response' }
}

// Exported for tests: one non-streamed response.
export function parseDeepSeekReply(data: unknown): LlmResult {
  if (!isRecord(data) || !Array.isArray(data.choices) || !isRecord(data.choices[0])) {
    return { kind: 'error', message: 'empty response' }
  }
  const choice = data.choices[0]
  const message = isRecord(choice.message) ? choice.message : {}
  const pieces: ToolCallPiece[] = Array.isArray(message.tool_calls)
    ? message.tool_calls.filter(isRecord).map(call => {
        const fn = isRecord(call.function) ? call.function : {}
        return {
          name: typeof fn.name === 'string' ? fn.name : '',
          arguments: typeof fn.arguments === 'string' ? fn.arguments : '',
        }
      })
    : []
  const text = typeof message.content === 'string' ? message.content : ''
  return finish(
    text,
    pieces,
    typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
  )
}

// Exported for tests: folds one streamed chunk into the reply so far.
export function foldDeepSeekChunk(
  state: { text: string; pieces: ToolCallPiece[]; finishReason: string | null },
  chunk: unknown,
): boolean {
  if (!isRecord(chunk) || !Array.isArray(chunk.choices) || !isRecord(chunk.choices[0])) return false
  const choice = chunk.choices[0]
  if (typeof choice.finish_reason === 'string') state.finishReason = choice.finish_reason
  const delta = isRecord(choice.delta) ? choice.delta : {}
  let textChanged = false
  if (typeof delta.content === 'string' && delta.content) {
    state.text += delta.content
    textChanged = true
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const call of delta.tool_calls.filter(isRecord)) {
      const index = typeof call.index === 'number' ? call.index : 0
      const fn = isRecord(call.function) ? call.function : {}
      const piece = (state.pieces[index] ??= { name: '', arguments: '' })
      if (typeof call.id === 'string') piece.id = call.id
      if (typeof fn.name === 'string') piece.name += fn.name
      if (typeof fn.arguments === 'string') piece.arguments += fn.arguments
    }
  }
  return textChanged
}

async function attempt(
  apiKey: string,
  model: string,
  turns: readonly LlmTurn[],
  options: ConverseOptions,
): Promise<LlmResult | { kind: 'http'; status: number }> {
  const stream = options.onText !== undefined
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: requestBody(model, turns, options, stream),
  })
  if (!response.ok) return { kind: 'http', status: response.status }
  if (!stream || !response.body) return parseDeepSeekReply(await response.json())
  const state = { text: '', pieces: [] as ToolCallPiece[], finishReason: null as string | null }
  await readSseStream(response.body, payload => {
    let chunk: unknown
    try {
      chunk = JSON.parse(payload)
    } catch {
      return
    }
    if (foldDeepSeekChunk(state, chunk) && state.pieces.length === 0) options.onText?.(state.text)
  })
  return finish(state.text, state.pieces, state.finishReason)
}

export async function converseDeepSeek(
  apiKey: string,
  model: string,
  turns: readonly LlmTurn[],
  options: ConverseOptions = {},
): Promise<LlmResult> {
  let lastErrorMessage = 'unknown error'
  for (let n = 1; n <= MAX_ATTEMPTS; n++) {
    if (n > 1) {
      options.onRetry?.(n, MAX_ATTEMPTS)
      await delay(RETRY_DELAY_MS)
    }
    try {
      const result = await attempt(apiKey, model, turns, options)
      if (result.kind !== 'http') return result
      lastErrorMessage = `DeepSeek returned ${result.status}`
      if (isTransient(result.status) && n < MAX_ATTEMPTS) continue
      return { kind: 'error', message: lastErrorMessage }
    } catch (e) {
      lastErrorMessage = e instanceof Error ? e.message : String(e)
      if (n < MAX_ATTEMPTS) continue
    }
  }
  return { kind: 'error', message: lastErrorMessage }
}
