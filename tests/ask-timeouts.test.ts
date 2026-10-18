import { afterEach, describe, expect, it, vi } from 'vitest'

// G2-84: nothing in a request may wait forever - a stalled storage read
// or connection left Jarvis stuck on the glasses with no answer.
vi.mock('../src/platform/bridge', () => ({
  status: vi.fn(),
  bridge: {
    // Never answers, like the stuck reads seen on the glasses.
    getLocalStorage: vi.fn(() => new Promise(() => {})),
    setLocalStorage: vi.fn(async () => true),
  },
}))

vi.mock('../src/core/llm', () => ({
  askModel: vi.fn(() => new Promise(() => {})),
  describeModel: () => 'fake',
}))

afterEach(() => {
  vi.resetModules()
})

describe('Jarvis never waits forever (G2-84)', () => {
  it('gives up on an AI that never answers', async () => {
    const { askAssistant } = await import('../src/features/chat/assistant')
    const reply = askAssistant(
      { provider: 'gemini', apiKey: 'k', model: 'gemini-3.6-flash' },
      [{ role: 'user', text: 'Hi', timestamp: 0 }],
      null,
      { timeoutMs: 1000 },
    )
    expect(await reply).toEqual({ kind: 'error', message: 'no answer in 1s' })
  }, 15_000)

  it('treats AI settings that never load as not set', async () => {
    const { getLlmConfig } = await import('../src/core/llmSettings')
    // Two rounds of 3 s read limits, then "no key".
    expect(await getLlmConfig('glasses')).toBeNull()
  }, 15_000)
})
