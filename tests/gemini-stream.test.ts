import { afterEach, describe, expect, it, vi } from 'vitest'
import { mergeStreamChunks, parseReply, parseSseEvents } from '../src/core/gemini'

const textChunk = (text: string) => ({ candidates: [{ content: { parts: [{ text }] } }] })

function sse(...chunks: unknown[]): string {
  return chunks.map(c => `data: ${JSON.stringify(c)}\r\n\r\n`).join('')
}

// A Response whose body arrives in the given pieces, split wherever the
// test says - the way a real network delivers a stream.
function streamedResponse(pieces: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece))
      controller.close()
    },
  })
  return new Response(body, { status: 200 })
}

describe('parseSseEvents', () => {
  it('returns complete events and keeps the unfinished one for later', () => {
    const { events, rest } = parseSseEvents('data: one\n\ndata: tw')
    expect(events).toEqual(['one'])
    expect(rest).toBe('data: tw')
  })

  it('handles CRLF line endings, multi-line data and ignores other fields', () => {
    const { events } = parseSseEvents('event: x\r\ndata: a\r\ndata: b\r\n\r\n: comment\n\n')
    expect(events).toEqual(['a\nb'])
  })
})

describe('mergeStreamChunks', () => {
  it('joins streamed text so parseReply reads it as one answer', () => {
    const merged = mergeStreamChunks([textChunk('Hel'), textChunk('lo.')])
    expect(parseReply(merged)).toEqual({ kind: 'answer', text: 'Hello.' })
  })

  it('keeps a function call that arrives in a chunk', () => {
    const call = {
      candidates: [
        { content: { parts: [{ functionCall: { name: 'startTimer', args: { minutes: 5 } } }] } },
      ],
    }
    expect(parseReply(mergeStreamChunks([call]))).toEqual({
      kind: 'actions',
      calls: [{ name: 'startTimer', args: { minutes: 5 } }],
    })
  })
})

describe('converse streaming', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('reports text as it arrives, across awkward network splits', async () => {
    const body = sse(textChunk('The capital '), textChunk('is Canberra.'))
    const fetchMock = vi.fn(async () =>
      streamedResponse([body.slice(0, 7), body.slice(7, 40), body.slice(40)]),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { converse } = await import('../src/core/gemini')
    const seen: string[] = []
    const result = await converse('key', [{ role: 'user', text: 'capital?' }], {
      onText: text => seen.push(text),
    })
    expect(result).toEqual({ kind: 'answer', text: 'The capital is Canberra.' })
    expect(seen).toEqual(['The capital ', 'The capital is Canberra.'])
    expect(String(fetchMock.mock.calls[0][0])).toContain(':streamGenerateContent?alt=sse')
  })

  it('falls back to the plain request when streaming fails, and stops trying it', async () => {
    const plain = () => new Response(JSON.stringify(textChunk('Canberra.')), { status: 200 })
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('streamGenerateContent')) throw new TypeError('Failed to fetch')
      return plain()
    })
    vi.stubGlobal('fetch', fetchMock)
    const { converse } = await import('../src/core/gemini')
    const ask = () => converse('key', [{ role: 'user', text: 'capital?' }], { onText: () => {} })
    expect(await ask()).toEqual({ kind: 'answer', text: 'Canberra.' })
    expect(await ask()).toEqual({ kind: 'answer', text: 'Canberra.' })
    const streamCalls = fetchMock.mock.calls.filter(([url]) => url.includes('stream'))
    expect(streamCalls).toHaveLength(1)
  })

  it('falls back when the stream answers with nothing readable', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('streamGenerateContent')
        ? streamedResponse(['not an event stream'])
        : new Response(JSON.stringify(textChunk('Canberra.')), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { converse } = await import('../src/core/gemini')
    const result = await converse('key', [{ role: 'user', text: 'capital?' }], {
      onText: () => {},
    })
    expect(result).toEqual({ kind: 'answer', text: 'Canberra.' })
  })

  it('does not stream when no onText is given', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(textChunk('Canberra.')), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { converse } = await import('../src/core/gemini')
    await converse('key', [{ role: 'user', text: 'capital?' }])
    expect(String(fetchMock.mock.calls[0][0])).toContain(':generateContent')
  })
})
