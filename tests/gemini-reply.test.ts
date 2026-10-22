import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/platform/bridge', () => ({
  bridge: { getLocalStorage: async () => '', setLocalStorage: async () => true },
  status: vi.fn(),
}))

import { parseReply } from '../src/core/gemini'

function reply(parts: unknown[]) {
  return { candidates: [{ content: { role: 'model', parts } }] }
}

describe('parseReply', () => {
  it('reads a plain answer', () => {
    expect(parseReply(reply([{ text: ' Hello there. ' }]))).toEqual({
      kind: 'answer',
      text: 'Hello there.',
    })
  })

  it('joins an answer split across parts', () => {
    expect(parseReply(reply([{ text: 'Hello ' }, { text: 'there.' }]))).toEqual({
      kind: 'answer',
      text: 'Hello there.',
    })
  })

  it('returns every function call, ignoring text alongside them', () => {
    const result = parseReply(
      reply([
        { text: 'Sure, doing that.' },
        { functionCall: { name: 'add_to_list', args: { list: 'Shopping', items: ['eggs'] } } },
        { functionCall: { name: 'start_timer', args: { minutes: 5 } }, thoughtSignature: 'abc' },
      ]),
    )
    expect(result).toEqual({
      kind: 'actions',
      calls: [
        { name: 'add_to_list', args: { list: 'Shopping', items: ['eggs'] } },
        { name: 'start_timer', args: { minutes: 5 } },
      ],
    })
  })

  it('treats a call with no args as empty args', () => {
    expect(parseReply(reply([{ functionCall: { name: 'cancel_timer' } }]))).toEqual({
      kind: 'actions',
      calls: [{ name: 'cancel_timer', args: {} }],
    })
  })

  it('never shows thought parts as the answer', () => {
    expect(
      parseReply(reply([{ text: 'planning...', thought: true }, { text: 'Answer.' }])),
    ).toEqual({ kind: 'answer', text: 'Answer.' })
  })

  it('reports an empty or malformed response as an error', () => {
    for (const data of [null, {}, { candidates: [] }, reply([]), reply([{ text: '  ' }])]) {
      expect(parseReply(data)).toEqual({ kind: 'error', message: 'empty response' })
    }
  })
})
