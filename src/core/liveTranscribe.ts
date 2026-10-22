// Streaming speech to text through Gemini's Live API (G2-134), for live
// captions: audio goes out as it is heard and words come back while the
// person is still talking, instead of Whisper's wait-for-a-pause-then-
// transcribe. From ai.google.dev/gemini-api/docs/live-api/live-transcribe:
// - model gemini-3.5-transcribe-live, free of charge on the free tier
//   (ai.google.dev/gemini-api/docs/pricing, checked 2026-10-22);
// - raw 16-bit PCM, 16 kHz, mono, little-endian - exactly what the glasses
//   microphone gives (shared/pcm.ts), sent in ~100 ms chunks as base64;
// - serverContent.interimInputTranscription.text: a guess that updates
//   while the person speaks; serverContent.inputTranscription.text: the
//   final text of a stretch of speech;
// - a session lasts at most 10 minutes, so it is replaced before then.

const URL_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'
export const LIVE_TRANSCRIBE_MODEL = 'gemini-3.5-transcribe-live'
// 100 ms of 16 kHz 16-bit mono audio.
const CHUNK_BYTES = 3200
// Well inside the 10-minute session limit.
const SESSION_MS = 9 * 60_000
const RETRY_MS = 2000

export type LiveTranscriber = {
  push(pcm: Uint8Array): void
  // Ends the audio, waits up to waitMs for the last words, then closes.
  finish(waitMs: number): Promise<void>
  close(): void
}

// Audio kept while the session is still connecting: 10 s.
const BACKLOG_BYTES = 320_000

export type LiveHandlers = {
  // The words so far of what is being said right now (replaces the last).
  onInterim(text: string): void
  // A finished stretch of speech.
  onFinal(text: string): void
  // Connection news for the diagnostics log. A handler rather than an import
  // of the bridge, so the PC can run this too (bench/liveCaptions.ts).
  onStatus?(text: string): void
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export function openLiveTranscriber(apiKey: string, handlers: LiveHandlers): LiveTranscriber {
  let socket: WebSocket | null = null
  let ready = false
  let closed = false
  let pending: Uint8Array[] = []
  let pendingBytes = 0
  let renewTimer: ReturnType<typeof setTimeout> | null = null
  let flushOnReady: (() => void) | null = null
  // Waiting in finish() for the last final.
  let finalWaiter: (() => void) | null = null

  function connect(): void {
    if (closed) return
    const ws = new WebSocket(`${URL_BASE}?key=${encodeURIComponent(apiKey)}`)
    socket = ws
    ready = false
    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          setup: {
            model: `models/${LIVE_TRANSCRIBE_MODEL}`,
            generationConfig: { responseModalities: ['TEXT'] },
            inputAudioTranscription: { languageCodes: [] },
          },
        }),
      )
    }
    ws.onmessage = async event => {
      const raw = typeof event.data === 'string' ? event.data : await (event.data as Blob).text()
      let message: {
        setupComplete?: unknown
        serverContent?: {
          interimInputTranscription?: { text?: string }
          inputTranscription?: { text?: string }
        }
        goAway?: unknown
      }
      try {
        message = JSON.parse(raw)
      } catch {
        return
      }
      if (message.setupComplete !== undefined) {
        ready = true
        handlers.onStatus?.('Captions: Gemini Live connected')
        flushOnReady?.()
        return
      }
      const content = message.serverContent
      const interim = content?.interimInputTranscription?.text
      if (interim) handlers.onInterim(interim)
      const final = content?.inputTranscription?.text?.trim()
      if (final) {
        handlers.onFinal(final)
        finalWaiter?.()
        finalWaiter = null
      }
      // The server is about to end the session: start the next one now.
      if (message.goAway !== undefined) renew()
    }
    ws.onclose = event => {
      if (socket !== ws) return
      socket = null
      ready = false
      if (closed) return
      handlers.onStatus?.(
        `Captions: Gemini Live closed (${event.code}${event.reason ? ` ${event.reason}` : ''})`,
      )
      setTimeout(connect, RETRY_MS)
    }
    if (renewTimer !== null) clearTimeout(renewTimer)
    renewTimer = setTimeout(renew, SESSION_MS)
  }

  // A fresh session before the old one runs out. The old one is dropped
  // without waiting; a word on the seam may be lost.
  function renew(): void {
    const old = socket
    socket = null
    old?.close()
    connect()
  }

  connect()

  // Sends what has built up. Before the session is ready the audio waits
  // (up to BACKLOG_BYTES, newest kept), so the first words of a question
  // said straight after a long press are not lost while connecting.
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
    socket.send(
      JSON.stringify({
        realtimeInput: { audio: { data: base64(chunk), mimeType: 'audio/pcm;rate=16000' } },
      }),
    )
  }
  flushOnReady = flush

  function close(): void {
    closed = true
    if (renewTimer !== null) clearTimeout(renewTimer)
    const ws = socket
    socket = null
    ws?.close()
  }

  return {
    push(pcm: Uint8Array): void {
      if (closed) return
      pending.push(pcm)
      pendingBytes += pcm.length
      if (pendingBytes >= CHUNK_BYTES) flush()
    },
    async finish(waitMs: number): Promise<void> {
      if (closed) return
      flush()
      if (ready && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }))
        // The last words come back as a final once the stream has ended.
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, waitMs)
          finalWaiter = () => {
            clearTimeout(timer)
            resolve()
          }
        })
      }
      close()
    },
    close,
  }
}
