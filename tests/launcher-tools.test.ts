import { describe, expect, it, vi } from 'vitest'

// The launcher lists Jarvis and Notes; Wingman and Parakeet are gone (G2-135).
vi.mock('../src/platform/bridge', () => ({
  status: vi.fn(),
  bridge: {
    getLocalStorage: vi.fn(async () => ''),
    setLocalStorage: vi.fn(async () => true),
  },
}))

describe('launcher tools (G2-100)', () => {
  it('has only Jarvis and Notes', async () => {
    const { TOOL_NAMES } = await import('../src/app/registry')
    expect(TOOL_NAMES).toContain('Jarvis')
    expect(TOOL_NAMES).toContain('Notes')
    expect(TOOL_NAMES).not.toContain('Wingman')
    expect(TOOL_NAMES).not.toContain('Parakeet')
    expect(TOOL_NAMES).not.toContain('Lab')
  })
})
