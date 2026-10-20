import { describe, expect, it, vi } from 'vitest'

// The launcher lists Jarvis and Notes; Wingman is switched off (G2-100).
vi.mock('../src/platform/bridge', () => ({
  status: vi.fn(),
  bridge: {
    getLocalStorage: vi.fn(async () => ''),
    setLocalStorage: vi.fn(async () => true),
  },
}))

describe('launcher tools (G2-100)', () => {
  it('has no Wingman while it is switched off', async () => {
    const { TOOL_NAMES } = await import('../src/app/registry')
    expect(TOOL_NAMES).toContain('Jarvis')
    expect(TOOL_NAMES).toContain('Notes')
    expect(TOOL_NAMES).not.toContain('Wingman')
    expect(TOOL_NAMES).not.toContain('Lab')
  })
})
