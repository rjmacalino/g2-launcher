import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/platform/bridge', () => ({
  status: vi.fn(),
  bridge: {
    getLocalStorage: vi.fn(async () => ''),
    setLocalStorage: vi.fn(async () => true),
  },
}))

const { MODES, getModePreset, modeOf } = await import('../src/core/modes')
const { chatSessions } = await import('../src/features/chat/store')

describe('Jarvis modes (G2-139)', () => {
  it('starts with Auto, which adds nothing', () => {
    expect(MODES[0].id).toBe('auto')
    expect(MODES[0].preset).toBe('')
  })

  it('reads an unknown or missing mode as Auto', () => {
    expect(modeOf(undefined).id).toBe('auto')
    expect(modeOf('nonsense').id).toBe('auto')
    expect(modeOf('interview').label).toBe('Interview')
  })

  it('falls back to the default preset when nothing is saved', async () => {
    expect(await getModePreset('coding')).toBe(modeOf('coding').preset)
  })

  it('keeps a chat mode with the chat, and none for Auto', () => {
    const first = { role: 'user' as const, text: 'Tell me about yourself', timestamp: 1 }
    expect(chatSessions.newSession(first, 'interview').mode).toBe('interview')
    expect(chatSessions.newSession(first, 'auto').mode).toBeUndefined()
    expect(chatSessions.newSession(first).mode).toBeUndefined()
  })
})
