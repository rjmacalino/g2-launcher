// Streaming speech to text through Deepgram (G2-157), the same job as
// core/liveTranscribe.ts's Gemini Live and the same LiveTranscriber shape,
// so voiceCapture.ts treats them alike. From the official docs
// (developers.deepgram.com/reference/speech-to-text/listen-streaming and
// /docs/using-the-sec-websocket-protocol, checked 2026-11-18):
// - wss://api.deepgram.com/v1/listen, settings as query parameters;
// - a browser cannot set an Authorization header on a WebSocket, so the key
//   goes in the subprotocol: new WebSocket(url, ['token', key]);
// - audio is sent as raw binary frames (linear16 at 16 kHz mono here,
//   exactly what the glasses microphone gives);
// - replies are JSON: type "Results" with channel.alternatives[0].transcript
//   and is_final (false: a guess that will change; true: settled text);
// - {"type": "CloseStream"} ends the audio: the server sends what is left,
//   then a "Metadata" message, then closes;
// - keyterm (Nova-3, up to 500 tokens in all) raises the odds of words the
//   model would otherwise mishear, like "tuple" or "LeetCode".

import { createAutoGain } from '../shared/gain'
import { BACKLOG_BYTES, type LiveHandlers, type LiveTranscriber } from './liveTranscribe'

const URL_BASE = 'wss://api.deepgram.com/v1/listen'
export const DEEPGRAM_MODEL = 'nova-3'
// 100 ms of 16 kHz 16-bit mono audio.
const CHUNK_BYTES = 3200
const RETRY_MS = 2000

export function deepgramUrl(keyterms: readonly string[]): string {
  const params = new URLSearchParams({
    model: DEEPGRAM_MODEL,
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    interim_results: 'true',
    smart_format: 'true',
  })
  for (const term of keyterms) params.append('keyterm', term)
  return `${URL_BASE}?${params.toString()}`
}

type DeepgramMessage = {
  type?: string
  is_final?: boolean
  channel?: { alternatives?: { transcript?: string }[] }
  description?: string
}

export function openDeepgramTranscriber(
  apiKey: string,
  keyterms: readonly string[],
  handlers: LiveHandlers,
): LiveTranscriber {
  let socket: WebSocket | null = null
  let ready = false
  let closed = false
  let pending: Uint8Array[] = []
  let pendingBytes = 0
  let sentBytes = 0
  // Waiting in finish() for the server to send what is left.
  let doneWaiter: (() => void) | null = null
  const amplify = createAutoGain()

  function connect(): void {
    if (closed) return
    const ws = new WebSocket(deepgramUrl(keyterms), ['token', apiKey])
    ws.binaryType = 'arraybuffer'
    socket = ws
    ready = false
    ws.onopen = () => {
      if (socket !== ws) return
      ready = true
      handlers.onStatus?.(`Captions: Deepgram ${DEEPGRAM_MODEL} connected`)
      handlers.onConnected?.(true)
      flush()
    }
    ws.onmessage = event => {
      if (typeof event.data !== 'string') return
      let message: DeepgramMessage
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.type === 'Results') {
        const text = message.channel?.alternatives?.[0]?.transcript?.trim() ?? ''
        if (message.is_final) {
          if (text) handlers.onFinal(text)
          else handlers.onInterim('')
        } else if (text) {
          handlers.onInterim(text)
        }
        return
      }
      if (message.type === 'Metadata') {
        doneWaiter?.()
        doneWaiter = null
        return
      }
      if (message.type === 'Error') {
        handlers.onStatus?.(`Captions: Deepgram error ${event.data.slice(0, 160)}`)
      }
    }
    ws.onclose = event => {
      if (socket !== ws) return
      socket = null
      ready = false
      doneWaiter?.()
      doneWaiter = null
      if (closed) return
      // A refused key closes during the handshake with 1006 and no reason;
      // the browser does not expose the HTTP status.
      handlers.onStatus?.(
        `Captions: Deepgram closed (${event.code}${event.reason ? ` ${event.reason}` : ''})`,
      )
      handlers.onConnected?.(false)
      setTimeout(connect, RETRY_MS)
    }
  }

  connect()

  // Sends what has built up. Before the socket is open the audio waits (up
  // to BACKLOG_BYTES, newest kept), so the first words are not lost.
  function flush(): void {
    if (pendingBytes === 0) return
    if (!ready || !socket || socket.readyState !== WebSocket.OPEN) {
      while (pendingBytes > BACKLOG_BYTES && pending.length > 1) {
        pendingBytes -= pending.shift()!.length
      }
      return
    }
    const chunk = new Uint8Array(pendingBytes)
    let at = 0
    for (const part of pending) {
      chunk.set(part, at)
      at += part.length
    }
    pending = []
    pendingBytes = 0
    socket.send(chunk)
    sentBytes += chunk.length
  }

  function close(): void {
    closed = true
    const ws = socket
    socket = null
    ws?.close()
  }

  return {
    push(raw: Uint8Array): void {
      if (closed) return
      const pcm = amplify(raw)
      pending.push(pcm)
      pendingBytes += pcm.length
      if (pendingBytes >= CHUNK_BYTES) flush()
    },
    async finish(waitMs: number): Promise<void> {
      if (closed) return
      flush()
      handlers.onStatus?.(
        `Captions: sent ${(sentBytes / 32000).toFixed(1)}s of audio${ready ? '' : ' (never connected)'}`,
      )
      const ws = socket
      if (ready && ws?.readyState === WebSocket.OPEN) {
        // The waiter is set before CloseStream goes out, so a reply that
        // comes back at once is not missed.
        const done = new Promise<void>(resolve => {
          const timer = setTimeout(resolve, waitMs)
          doneWaiter = () => {
            clearTimeout(timer)
            resolve()
          }
        })
        ws.send(JSON.stringify({ type: 'CloseStream' }))
        await done
      }
      close()
    },
    close,
  }
}
