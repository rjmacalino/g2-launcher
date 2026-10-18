import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROVIDERS, defaultModel } from '../src/core/llmProviders'
import { thinkingConfig } from '../src/core/gemini'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('model per job (G2-77)', () => {
  it('gives Wingman the fastest model and the phone a smarter one', () => {
    expect(defaultModel('gemini', 'wingman')).toBe('gemini-3.5-flash-lite')
    expect(defaultModel('gemini', 'glasses')).toBe('gemini-3.6-flash')
    expect(defaultModel('gemini', 'phone')).toBe('gemini-3.8-flash')
    expect(defaultModel('claude', 'wingman')).toBe('claude-haiku-5-5')
    expect(defaultModel('claude', 'phone')).toBe('claude-sonnet-5-5')
    expect(defaultModel('deepseek', 'wingman')).toBe('deepseek-flash')
    expect(defaultModel('local', 'wingman')).toBe('llama3.2:3b')
    expect(defaultModel('local', 'glasses')).toBe('qwen2.5:3b')
  })

  it('always picks a model the provider lists', () => {
    for (const p of PROVIDERS) {
      for (const purpose of ['glasses', 'phone', 'wingman'] as const) {
        expect(p.models.map(m => m.id)).toContain(defaultModel(p.id, purpose))
      }
    }
  })

  it('turns Gemini thinking off in the form each model accepts', () => {
    expect(thinkingConfig('gemini-3.8-flash')).toEqual({ thinkingBudget: 0 })
    expect(thinkingConfig('gemini-3.6-flash')).toEqual({ thinkingBudget: 0 })
    expect(thinkingConfig('gemini-3.5-flash-lite')).toEqual({ thinkingLevel: 'minimal' })
  })

  it('sends a Gemini request to the chosen model', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hi.' }] } }] })),
    )
    vi.stubGlobal('fetch', fetchMock)
    const { converse } = await import('../src/core/gemini')
    await converse('k', [{ role: 'user', text: 'q' }], {}, 'gemini-3.5-flash-lite')
    expect(fetchMock.mock.calls[0][0]).toContain('/gemini-3.5-flash-lite:generateContent')
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'minimal' })
  })
})

describe('local model address (G2-78)', () => {
  it('fills in the scheme and Ollama port when left out', async () => {
    const { localEndpoint } = await import('../src/core/llmProviders')
    expect(localEndpoint('192.168.1.20')).toBe('http://192.168.1.20:11434/v1/chat/completions')
    expect(localEndpoint('http://pc.lan:8080/')).toBe('http://pc.lan:8080/v1/chat/completions')
  })
})
