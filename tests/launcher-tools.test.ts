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
  it('has Jarvis, Interview, Code and Notes (G2-152)', async () => {
    const { TOOL_NAMES } = await import('../src/app/registry')
    expect(TOOL_NAMES).toEqual(['Jarvis', 'Interview', 'Code', 'Notes'])
    expect(TOOL_NAMES).not.toContain('Wingman')
    expect(TOOL_NAMES).not.toContain('Parakeet')
    expect(TOOL_NAMES).not.toContain('Lab')
  })
})
