import { describe, expect, it, vi } from 'vitest'

// A tiny in-memory phone storage.
const store = new Map<string, string>()
vi.mock('../src/platform/bridge', () => ({
  status: vi.fn(),
  bridge: {
    getLocalStorage: vi.fn(async (key: string) => store.get(key) ?? ''),
    setLocalStorage: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
      return true
    }),
  },
}))

const { readEditable, resetEditable, writeEditable } = await import('../src/core/editableText')
const defaults = (await import('../src/defaults/instructions.json')).default
const { CHAT_INSTRUCTION, WEARER_INSTRUCTION } = await import('../src/core/llmTypes')

describe('Settings texts with a default (G2-145)', () => {
  it('starts as the default, then is what the wearer saved', async () => {
    expect(await readEditable('k', 'default')).toBe('default')
    await writeEditable('k', 'mine', 100, 'k')
    expect(await readEditable('k', 'default')).toBe('mine')
  })

  it('stays empty when deleted, instead of coming back as the default', async () => {
    await writeEditable('k', '   ', 100, 'k')
    expect(await readEditable('k', 'default')).toBe('')
  })

  it('brings the default back on reset', async () => {
    await resetEditable('k', 'k')
    expect(await readEditable('k', 'default')).toBe('default')
  })
})

describe('instruction text lives in the data file (G2-146)', () => {
  it('builds the system instructions from it', () => {
    expect(CHAT_INSTRUCTION).toBe(`${defaults.jarvisIdentity} ${defaults.displayRules}`)
    expect(WEARER_INSTRUCTION).toBe(`${defaults.wearerIdentity} ${defaults.displayRules}`)
  })
})
