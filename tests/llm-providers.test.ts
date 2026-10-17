import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSystemPrompt, toJsonSchema } from '../src/core/llmTypes'
import { foldDeepSeekChunk, parseDeepSeekReply } from '../src/core/deepseek'
import type { FunctionDeclaration } from '../src/core/llmTypes'

const ADD_ITEMS: FunctionDeclaration = {
  name: 'add_list_items',
  description: 'Add items to a list',
  parameters: {
    type: 'OBJECT',
    properties: {
      list: { type: 'STRING' },
      items: { type: 'ARRAY', items: { type: 'STRING' } },
    },
    required: ['list', 'items'],
  },
}

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(e))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('shared prompt and schema', () => {
  it('converts Gemini schema types to JSON Schema', () => {
    expect(toJsonSchema(ADD_ITEMS.parameters)).toEqual({
      type: 'object',
      properties: { list: { type: 'string' }, items: { type: 'array', items: { type: 'string' } } },
      required: ['list', 'items'],
    })
    expect(toJsonSchema(undefined)).toEqual({ type: 'object', properties: {} })
  })

  it('builds one system prompt for every provider', () => {
    const prompt = buildSystemPrompt({ aboutMe: 'I am Sam.', functions: [ADD_ITEMS] })
    expect(prompt).toContain('You are Jarvis')
    expect(prompt).toContain('I am Sam.')
    expect(prompt).toContain('Reminders')
  })
})

describe('DeepSeek', () => {
  it('reads an answer', () => {
    const reply = { choices: [{ message: { content: 'Canberra.' }, finish_reason: 'stop' }] }
    expect(parseDeepSeekReply(reply)).toEqual({ kind: 'answer', text: 'Canberra.' })
  })

  it('reads tool calls, whose arguments come as a JSON string', () => {
    const reply = {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: {
                  name: 'add_list_items',
                  arguments: '{"list":"Shopping","items":["milk"]}',
                },
              },
              { id: 'c2', type: 'function', function: { name: 'broken', arguments: '{"list":' } },
            ],
          },
        },
      ],
    }
    expect(parseDeepSeekReply(reply)).toEqual({
      kind: 'actions',
      calls: [{ name: 'add_list_items', args: { list: 'Shopping', items: ['milk'] } }],
    })
  })

  it('stitches streamed tool-call pieces back together by index', () => {
    const state = { text: '', pieces: [], finishReason: null as string | null }
    const chunks = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'c1', function: { name: 'add_list_items', arguments: '' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '{"list":"Shop' } }] } },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: 'ping","items":["eggs"]}' } }],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]
    for (const c of chunks) foldDeepSeekChunk(state, c)
    expect(state.pieces[0]).toMatchObject({
      name: 'add_list_items',
      arguments: '{"list":"Shopping","items":["eggs"]}',
    })
    expect(state.finishReason).toBe('tool_calls')
  })

  it('streams text, turns thinking off, and sends tools in its own format', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Can"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"berra."},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { converseDeepSeek } = await import('../src/core/deepseek')
    const seen: string[] = []
    const result = await converseDeepSeek(
      'k',
      'deepseek-flash',
      [{ role: 'user', text: 'capital?' }],
      {
        onText: t => seen.push(t),
        functions: [ADD_ITEMS],
      },
    )
    expect(result).toEqual({ kind: 'answer', text: 'Canberra.' })
    expect(seen).toEqual(['Can', 'Canberra.'])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k')
    const body = JSON.parse(String(init.body))
    expect(body.model).toBe('deepseek-flash')
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.messages[0].role).toBe('system')
    expect(body.tools[0]).toMatchObject({ type: 'function', function: { name: 'add_list_items' } })
    expect(body.tools[0].function.parameters.type).toBe('object')
  })
})

// The real Anthropic SDK, fed a faked HTTP stream in the Messages API's
// server-sent event format.
function claudeStream(blocks: object[], stopReason: string): Response {
  const events: string[] = []
  const send = (type: string, data: object) =>
    events.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  send('message_start', {
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  })
  blocks.forEach((block, index) => {
    const b = block as { type: string; text?: string; name?: string; input?: object }
    if (b.type === 'text') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } })
      for (const piece of (b.text ?? '').match(/.{1,5}/g) ?? []) {
        send('content_block_delta', { index, delta: { type: 'text_delta', text: piece } })
      }
    } else {
      send('content_block_start', {
        index,
        content_block: { type: 'tool_use', id: `tu_${index}`, name: b.name, input: {} },
      })
      send('content_block_delta', {
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) },
      })
    }
    send('content_block_stop', { index })
  })
  send('message_delta', {
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 5 },
  })
  send('message_stop', {})
  return sseResponse(events)
}

describe('Claude, through the official SDK', () => {
  it('streams an answer and sends the browser, fallback and effort settings', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      claudeStream([{ type: 'text', text: 'The capital is Canberra.' }], 'end_turn'),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { converseClaude } = await import('../src/core/claude')
    const seen: string[] = []
    const result = await converseClaude(
      'k',
      'claude-opus-5-5',
      [{ role: 'user', text: 'capital?' }],
      {
        onText: t => seen.push(t),
        effort: 'low',
      },
    )
    expect(result).toEqual({ kind: 'answer', text: 'The capital is Canberra.' })
    expect(seen[seen.length - 1]).toBe('The capital is Canberra.')
    expect(seen.length).toBeGreaterThan(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/v1/messages')
    const headers = new Headers(init?.headers)
    expect(headers.get('anthropic-dangerous-direct-browser-access')).toBe('true')
    expect(headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01')
    expect(headers.get('x-api-key')).toBe('k')
    const body = JSON.parse(String(init?.body))
    expect(body.model).toBe('claude-opus-5-5')
    expect(body.fallbacks).toBe('default')
    expect(body.output_config).toEqual({ effort: 'low' })
    expect(body.thinking).toBeUndefined()
    expect(body.system).toContain('You are Jarvis')
  })

  it('returns tool calls as actions, with streamed tool input', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        claudeStream(
          [
            {
              type: 'tool_use',
              name: 'add_list_items',
              input: { list: 'Shopping', items: ['milk'] },
            },
          ],
          'tool_use',
        ),
      ),
    )
    const { converseClaude } = await import('../src/core/claude')
    const result = await converseClaude(
      'k',
      'claude-haiku-5-5',
      [{ role: 'user', text: 'add milk' }],
      {
        functions: [ADD_ITEMS],
      },
    )
    expect(result).toEqual({
      kind: 'actions',
      calls: [{ name: 'add_list_items', args: { list: 'Shopping', items: ['milk'] } }],
    })
  })

  it('sends no fallback for Haiku, which has none', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      claudeStream([{ type: 'text', text: 'Hi.' }], 'end_turn'),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { converseClaude } = await import('../src/core/claude')
    await converseClaude('k', 'claude-haiku-5-5', [{ role: 'user', text: 'hi' }])
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body.fallbacks).toBeUndefined()
  })

  it('reports a refusal instead of an empty answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => claudeStream([], 'refusal')),
    )
    const { converseClaude } = await import('../src/core/claude')
    const result = await converseClaude('k', 'claude-opus-5-5', [{ role: 'user', text: '?' }])
    expect(result).toEqual({ kind: 'error', message: 'Claude declined to answer this' })
  })

  it('names a bad key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              type: 'error',
              error: { type: 'authentication_error', message: 'invalid x-api-key' },
            }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          ),
      ),
    )
    const { converseClaude } = await import('../src/core/claude')
    const result = await converseClaude('bad', 'claude-opus-5-5', [{ role: 'user', text: '?' }])
    expect(result).toEqual({ kind: 'error', message: 'Claude rejected the API key' })
  })
})
