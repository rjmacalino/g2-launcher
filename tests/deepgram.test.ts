import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deepgramUrl, openDeepgramTranscriber } from '../src/core/deepgramTranscribe'
import { createAutoGain } from '../src/shared/gain'

// A stand-in for the browser WebSocket, answering the way Deepgram's docs
// describe (G2-157): JSON "Results" with is_final, "Metadata" after
// CloseStream, then a close.
class FakeSocket {
  static OPEN = 1
  static last: FakeSocket | null = null
  readyState = 0
  binaryType = ''
  sent: (string | Uint8Array)[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  constructor(
    public url: string,
    public protocols: string[],
  ) {
    FakeSocket.last = this
  }
  send(data: string | Uint8Array) {
    this.sent.push(data)
    if (typeof data === 'string' && JSON.parse(data).type === 'CloseStream') {
      this.reply({
        type: 'Results',
        is_final: true,
        channel: { alternatives: [{ transcript: 'a tuple?' }] },
      })
      this.reply({ type: 'Metadata' })
    }
  }
  close() {
    this.readyState = 3
    this.onclose?.({ code: 1000, reason: '' })
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  reply(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

const results = (transcript: string, isFinal: boolean) => ({
  type: 'Results',
  is_final: isFinal,
  channel: { alternatives: [{ transcript }] },
})

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('deepgramUrl', () => {
  it('asks for Nova-3 on 16 kHz linear16 mono with interim results and each key term', () => {
    const url = new URL(deepgramUrl(['tuple', 'hash map']))
    expect(url.origin + url.pathname).toBe('wss://api.deepgram.com/v1/listen')
    expect(url.searchParams.get('model')).toBe('nova-3')
    expect(url.searchParams.get('encoding')).toBe('linear16')
    expect(url.searchParams.get('sample_rate')).toBe('16000')
    expect(url.searchParams.get('channels')).toBe('1')
    expect(url.searchParams.get('interim_results')).toBe('true')
    expect(url.searchParams.getAll('keyterm')).toEqual(['tuple', 'hash map'])
  })
})

describe('openDeepgramTranscriber', () => {
  it('sends the key as the token subprotocol, never in the URL', () => {
    const t = openDeepgramTranscriber('secret-key', [], { onInterim() {}, onFinal() {} })
    expect(FakeSocket.last!.protocols).toEqual(['token', 'secret-key'])
    expect(FakeSocket.last!.url).not.toContain('secret-key')
    t.close()
  })

  it('holds audio until connected, then streams it as binary', () => {
    const connected: boolean[] = []
    const t = openDeepgramTranscriber('k', [], {
      onInterim() {},
      onFinal() {},
      onConnected: c => connected.push(c),
    })
    const socket = FakeSocket.last!
    t.push(new Uint8Array(4000))
    expect(socket.sent).toEqual([])
    socket.open()
    expect(connected).toEqual([true])
    expect(socket.sent).toHaveLength(1)
    expect(socket.sent[0]).toBeInstanceOf(Uint8Array)
    expect((socket.sent[0] as Uint8Array).length).toBe(4000)
    t.close()
  })

  it('turns interim and final results into captions and finals', () => {
    const interims: string[] = []
    const finals: string[] = []
    const t = openDeepgramTranscriber('k', [], {
      onInterim: x => interims.push(x),
      onFinal: x => finals.push(x),
    })
    const socket = FakeSocket.last!
    socket.open()
    socket.reply(results('what is', false))
    socket.reply(results('what is a lambda', true))
    socket.reply({ type: 'SpeechStarted' })
    expect(interims).toEqual(['what is'])
    expect(finals).toEqual(['what is a lambda'])
    t.close()
  })

  it('finish sends CloseStream and resolves once the last words and Metadata arrive', async () => {
    const finals: string[] = []
    const t = openDeepgramTranscriber('k', [], { onInterim() {}, onFinal: x => finals.push(x) })
    const socket = FakeSocket.last!
    socket.open()
    await t.finish(5000)
    expect(socket.sent.some(s => typeof s === 'string' && s.includes('CloseStream'))).toBe(true)
    expect(finals).toEqual(['a tuple?'])
    expect(socket.readyState).toBe(3)
  })

  it('reports a dropped connection and reconnects', () => {
    vi.useFakeTimers()
    const connected: boolean[] = []
    const t = openDeepgramTranscriber('k', [], {
      onInterim() {},
      onFinal() {},
      onConnected: c => connected.push(c),
    })
    const first = FakeSocket.last!
    first.onclose?.({ code: 1006, reason: '' })
    expect(connected).toEqual([false])
    vi.advanceTimersByTime(2000)
    expect(FakeSocket.last).not.toBe(first)
    t.close()
    vi.useRealTimers()
  })
})

describe('createAutoGain', () => {
  it('raises quiet audio but never past 16x, and leaves loud audio alone', () => {
    const gain = createAutoGain()
    const quiet = new Int16Array([100, -100])
    const out = new Int16Array(gain(new Uint8Array(quiet.buffer)).buffer)
    expect(Array.from(out)).toEqual([1600, -1600])
    const loud = new Uint8Array(new Int16Array([30000, -30000]).buffer)
    expect(createAutoGain()(loud)).toBe(loud)
  })
})
