import { beforeEach, describe, expect, it, vi } from 'vitest'

// core/mic.ts talks to the SDK bridge, which needs the page; a fake bridge
// records what the mic was told to do instead.
const calls: boolean[] = []
let eventHandler: ((event: unknown) => void) | null = null

vi.mock('../src/platform/bridge', () => ({
  bridge: {
    audioControl: vi.fn(async (on: boolean) => {
      calls.push(on)
      return true
    }),
    onEvenHubEvent: vi.fn((fn: (event: unknown) => void) => {
      eventHandler = fn
      return () => {
        eventHandler = null
      }
    }),
  },
}))

beforeEach(() => {
  calls.length = 0
  vi.resetModules()
})

function audio(byte: number) {
  // AudioInputSource.Glasses is the string "glasses" in the SDK's enum.
  eventHandler?.({ audioEvent: { source: 'glasses', audioPcm: new Uint8Array([byte]) } })
}

describe('shared mic', () => {
  it('stays on until the last listener lets go', async () => {
    const { openMic } = await import('../src/core/mic')
    const heardA: number[] = []
    const heardB: number[] = []
    const releaseA = await openMic(pcm => heardA.push(pcm[0]))
    const releaseB = await openMic(pcm => heardB.push(pcm[0]))
    expect(calls).toEqual([true])
    audio(1)
    releaseA?.()
    expect(calls).toEqual([true])
    audio(2)
    releaseB?.()
    expect(calls).toEqual([true, false])
    expect(heardA).toEqual([1])
    expect(heardB).toEqual([1, 2])
  })

  it('switches back on after the background, only if someone is listening', async () => {
    const { openMic, micResumed, micSuspended } = await import('../src/core/mic')
    micSuspended()
    micResumed()
    expect(calls).toEqual([])
    const release = await openMic(() => {})
    micSuspended()
    micResumed()
    expect(calls).toEqual([true, true])
    release?.()
  })

  it('ignores a second release from the same listener', async () => {
    const { openMic } = await import('../src/core/mic')
    const releaseA = await openMic(() => {})
    const releaseB = await openMic(() => {})
    releaseA?.()
    releaseA?.()
    expect(calls).toEqual([true])
    releaseB?.()
    expect(calls).toEqual([true, false])
  })
})
