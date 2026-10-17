import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

const grounded = {
  candidates: [
    {
      content: { parts: [{ text: 'It closes at 9 pm.' }] },
      groundingMetadata: {
        webSearchQueries: ['store hours'],
        groundingChunks: [
          { web: { uri: 'https://a.example/1', title: 'a.example' } },
          { web: { uri: 'https://a.example/2', title: 'a.example' } },
          { web: { uri: 'https://b.example', title: 'b.example' } },
        ],
      },
    },
  ],
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status })
}

describe('Gemini web search', () => {
  it('asks with the googleSearch tool and returns the sources, one per site', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => json(grounded))
    vi.stubGlobal('fetch', fetchMock)
    const { converse } = await import('../src/core/gemini')
    const result = await converse('k', [{ role: 'user', text: 'When does it close?' }], {
      webSearch: true,
    })
    expect(result).toEqual({
      kind: 'answer',
      text: 'It closes at 9 pm.',
      sources: [
        { title: 'a.example', url: 'https://a.example/1' },
        { title: 'b.example', url: 'https://b.example' },
      ],
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).tools).toEqual([
      { googleSearch: {} },
    ])
  })

  it('keeps sources that arrive on a streamed chunk', async () => {
    const { mergeStreamChunks, parseReply } = await import('../src/core/gemini')
    const merged = mergeStreamChunks([
      { candidates: [{ content: { parts: [{ text: 'It closes ' }] } }] },
      grounded,
    ])
    const result = parseReply(merged)
    expect(result.kind === 'answer' && result.sources?.length).toBe(2)
  })

  it('drops search and asks again if Gemini refuses the request with it', async () => {
    const bodies: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        return bodies.length === 1 ? json({ error: {} }, 400) : json(grounded)
      }),
    )
    const { converse } = await import('../src/core/gemini')
    const ask = () => converse('k', [{ role: 'user', text: 'q' }], { webSearch: true })
    expect((await ask()).kind).toBe('answer')
    expect(JSON.parse(bodies[0]).tools).toEqual([{ googleSearch: {} }])
    expect(JSON.parse(bodies[1]).tools).toBeUndefined()
    await ask()
    expect(JSON.parse(bodies[2]).tools).toBeUndefined()
  })
})

// Anthropic's streaming format, as in tests/llm-providers.test.ts.
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
    const b = block as { type: string; text?: string }
    if (b.type === 'text') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } })
      send('content_block_delta', { index, delta: { type: 'text_delta', text: b.text } })
    } else {
      send('content_block_start', { index, content_block: block })
    }
    send('content_block_stop', { index })
  })
  send('message_delta', {
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 5 },
  })
  send('message_stop', {})
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(c) {
        events.forEach(e => c.enqueue(encoder.encode(e)))
        c.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

const searchResult = {
  type: 'web_search_tool_result',
  tool_use_id: 'srv_1',
  content: [
    {
      type: 'web_search_result',
      url: 'https://c.example',
      title: 'C',
      encrypted_content: 'x',
      page_age: null,
    },
  ],
}

describe('Claude web search', () => {
  it('uses the dynamic search tool on Opus 5.5 and the basic one on Haiku', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      claudeStream([{ type: 'text', text: 'Hi.' }], 'end_turn'),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { converseClaude } = await import('../src/core/claude')
    await converseClaude('k', 'claude-opus-5-5', [{ role: 'user', text: 'q' }], { webSearch: true })
    await converseClaude('k', 'claude-haiku-5-5', [{ role: 'user', text: 'q' }], {
      webSearch: true,
    })
    const tool = (i: number) => JSON.parse(String(fetchMock.mock.calls[i][1]?.body)).tools[0]
    expect(tool(0)).toMatchObject({ type: 'web_search_20260209', name: 'web_search', max_uses: 3 })
    expect(tool(1)).toMatchObject({ type: 'web_search_20250305', name: 'web_search' })
  })

  it('resumes a paused turn and returns the answer with its sources', async () => {
    const replies = [
      claudeStream([searchResult], 'pause_turn'),
      claudeStream([{ type: 'text', text: 'It is sunny in Tokyo.' }], 'end_turn'),
    ]
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => replies.shift()!)
    vi.stubGlobal('fetch', fetchMock)
    const { converseClaude } = await import('../src/core/claude')
    const result = await converseClaude(
      'k',
      'claude-opus-5-5',
      [{ role: 'user', text: 'Tokyo?' }],
      {
        webSearch: true,
      },
    )
    expect(result).toEqual({
      kind: 'answer',
      text: 'It is sunny in Tokyo.',
      sources: [{ title: 'C', url: 'https://c.example' }],
    })
    const second = JSON.parse(String(fetchMock.mock.calls[1][1]?.body))
    expect(second.messages.at(-1).role).toBe('assistant')
  })
})
