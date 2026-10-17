import Anthropic from '@anthropic-ai/sdk'
import {
  buildSystemPrompt,
  isRecord,
  toJsonSchema,
  type ConverseOptions,
  type FunctionCall,
  type LlmResult,
  type LlmTurn,
  type Source,
} from './llmTypes'

// Claude as Jarvis's model (G2-68), a paid option next to Gemini's free
// tier, through Anthropic's official TypeScript SDK (@anthropic-ai/sdk).
// Loaded only when Claude is the chosen provider (core/llm.ts imports this
// file dynamically), so the SDK costs the app nothing otherwise.
//
// Browser use: the SDK refuses to run in a browser unless
// dangerouslyAllowBrowser is set, because a key in a web page can be read
// by whoever has the page. Here the page is the wearer's own app on their
// own phone and the key is one they typed into it - the same arrangement
// as the Gemini key (never bundled, see core/llmSettings.ts). Anthropic's
// API answers CORS preflights for browser calls (checked with a real
// preflight).
//
// Request choices, from the claude-api skill's guidance for these models:
// - thinking is left at the default (adaptive; Claude Opus 5.5 cannot turn
//   it off), and effort is the speed control - Wingman's cues ask for
//   'low', since a late cue is no use.
// - max_tokens is larger than the other providers' caps because thinking
//   counts against it: a 60-token cue budget would leave no room to think.
// - server-side refusal fallback is on for the models that support it, so
//   a declined request is retried on another model inside the same call.
// - tools stream their input as it is written (eager_input_streaming); the
//   server then no longer validates it, so a reply cut off mid-call is
//   never run, and Jarvis's actions check every argument's type
//   themselves (features/notes/actions.ts, features/timer/actions.ts).

export const CLAUDE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] as const

const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5'])
const CLAUDE_MAX_TOKENS = 16000
// One re-issue when the reply's tool input could not be parsed at all - the
// only failure the SDK does not already retry itself (it retries 429, 5xx
// and dropped connections on its own).
const MAX_PARSE_RETRIES = 1

// Web search (G2-76), Anthropic's server tool: the newer version with
// dynamic filtering on the models the claude-api skill lists for it, the
// basic one otherwise (Haiku). Three searches at most per question.
const DYNAMIC_SEARCH_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5'])
const MAX_SEARCHES = 3
// A turn using a server tool can pause ("pause_turn") and is resumed by
// sending it back as it is; a couple of resumes covers a few searches.
const MAX_RESUMES = 2

function searchTool(model: string) {
  return DYNAMIC_SEARCH_MODELS.has(model)
    ? { type: 'web_search_20260209' as const, name: 'web_search' as const, max_uses: MAX_SEARCHES }
    : { type: 'web_search_20250305' as const, name: 'web_search' as const, max_uses: MAX_SEARCHES }
}

// The pages the search results came from, at most three.
function sourcesOf(content: readonly Anthropic.Beta.BetaContentBlock[]): Source[] {
  const sources: Source[] = []
  for (const block of content) {
    if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue
    for (const result of block.content) {
      if (sources.some(s => s.url === result.url)) continue
      sources.push({ title: result.title || result.url, url: result.url })
      if (sources.length === 3) return sources
    }
  }
  return sources
}

export async function converseClaude(
  apiKey: string,
  model: string,
  turns: readonly LlmTurn[],
  options: ConverseOptions = {},
): Promise<LlmResult> {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })
  const functions = options.functions ?? []
  const withFallback = FALLBACK_MODELS.has(model)
  const tools = [
    ...functions.map(f => ({
      name: f.name,
      description: f.description,
      input_schema: toJsonSchema(f.parameters) as Anthropic.Beta.BetaTool.InputSchema,
      eager_input_streaming: true,
    })),
    ...(options.webSearch ? [searchTool(model)] : []),
  ]

  for (let parseRetries = 0; ; parseRetries++) {
    let text = ''
    const messages: Anthropic.Beta.BetaMessageParam[] = turns.map(turn => ({
      role: turn.role === 'model' ? ('assistant' as const) : ('user' as const),
      content: turn.text,
    }))
    const content: Anthropic.Beta.BetaContentBlock[] = []
    try {
      for (let resumes = 0; ; resumes++) {
        const stream = client.beta.messages.stream({
          model,
          max_tokens: CLAUDE_MAX_TOKENS,
          system: buildSystemPrompt(options),
          messages,
          ...(options.effort ? { output_config: { effort: options.effort } } : {}),
          ...(tools.length > 0 ? { tools } : {}),
          ...(withFallback
            ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
            : {}),
        })
        stream.on('text', delta => {
          text += delta
          options.onText?.(text)
        })
        const message = await stream.finalMessage()
        content.push(...message.content)

        if (message.stop_reason === 'refusal') {
          return { kind: 'error', message: 'Claude declined to answer this' }
        }
        if (message.stop_reason === 'pause_turn' && resumes < MAX_RESUMES) {
          messages.push({ role: 'assistant', content: message.content })
          continue
        }
        const calls: FunctionCall[] = []
        const texts: string[] = []
        for (const block of content) {
          if (block.type === 'tool_use') {
            calls.push({ name: block.name, args: isRecord(block.input) ? block.input : {} })
          } else if (block.type === 'text') {
            texts.push(block.text)
          }
        }
        if (calls.length > 0) {
          // A tool input cut off by the token limit can still parse; never
          // run a half-written call.
          if (message.stop_reason === 'max_tokens') {
            return { kind: 'error', message: 'reply cut off' }
          }
          return { kind: 'actions', calls }
        }
        const answer = texts.join('').trim()
        if (!answer) return { kind: 'error', message: 'empty response' }
        const sources = sourcesOf(content)
        return sources.length > 0
          ? { kind: 'answer', text: answer, sources }
          : { kind: 'answer', text: answer }
      }
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) {
        return { kind: 'error', message: 'Claude rejected the API key' }
      }
      if (e instanceof Anthropic.RateLimitError) {
        return { kind: 'error', message: 'Claude rate limit - try again shortly' }
      }
      if (e instanceof Anthropic.APIError) {
        return { kind: 'error', message: `Claude returned ${e.status ?? 'an error'}` }
      }
      if (parseRetries < MAX_PARSE_RETRIES) continue
      return { kind: 'error', message: e instanceof Error ? e.message : String(e) }
    }
  }
}
