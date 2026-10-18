import { describe, expect, it, vi } from 'vitest'

// G2-85: a 429 on one Gemini model moves on to the next.
vi.mock('../src/platform/bridge', () => ({ status: vi.fn() }))

const asked: string[] = []
vi.mock('../src/core/gemini', () => ({
  converse: vi.fn(async (_key: string, _turns: unknown, _options: unknown, model: string) => {
    asked.push(model)
    return model === 'gemini-3.6-flash'
      ? { kind: 'answer', text: 'Hi.' }
      : { kind: 'error', message: 'Gemini returned 429' }
  }),
}))

describe('Gemini daily limits (G2-85)', () => {
  it('tries the other models when the chosen one is out, and skips it next time', async () => {
    const { askModel } = await import('../src/core/llm')
    const config = { provider: 'gemini' as const, apiKey: 'k', model: 'gemini-3.8-flash' }
    const turns = [{ role: 'user' as const, text: 'q' }]
    expect(await askModel(config, turns)).toEqual({ kind: 'answer', text: 'Hi.' })
    expect(asked[0]).toBe('gemini-3.8-flash')
    expect(asked).toContain('gemini-3.6-flash')
    asked.length = 0
    await askModel(config, turns)
    expect(asked).not.toContain('gemini-3.8-flash')
  })
})
