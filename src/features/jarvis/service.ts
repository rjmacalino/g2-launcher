// Browser SpeechRecognition, confirmed present in the real Even Hub app's
// WebView on real hardware [HW] (see docs/platform.md decision D1 and the
// Lab probe this replaces with a real feature). No official DOM types ship
// for it - it is a non-standard API, not part of tsconfig's "DOM" lib - so
// this file defines only the shape it actually calls, same untyped-cast
// approach Lab's own probe used to check for it.
export type VoiceResult =
  | { kind: 'transcript'; transcript: string }
  | { kind: 'error'; message: string }
  | { kind: 'unavailable' }

type RecognitionResultEvent = {
  results: { [index: number]: { [index: number]: { transcript: string } } }
}

type RecognitionErrorEvent = {
  error?: string
}

type Recognition = {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  onresult: ((event: RecognitionResultEvent) => void) | null
  onerror: ((event: RecognitionErrorEvent) => void) | null
  onend: (() => void) | null
}

function getRecognitionCtor(): (new () => Recognition) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => Recognition
    webkitSpeechRecognition?: new () => Recognition
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

let active: Recognition | null = null

// One-shot: starts listening, resolves with a single result (or error), then
// stops - matches the Web Speech API's own non-continuous mode rather than
// this file managing restarts itself. An always-listen mode, if it is ever
// built, is a different function layered on top of this one (auto-restart
// after each result), not a flag threaded through it.
export function listenOnce(): Promise<VoiceResult> {
  const Ctor = getRecognitionCtor()
  if (!Ctor) return Promise.resolve({ kind: 'unavailable' })

  return new Promise(resolve => {
    let settled = false
    // Guards against a hang: onend can fire without onresult or onerror
    // ever having run (the browser simply gave up), and this promise must
    // still settle either way.
    function settle(result: VoiceResult) {
      if (settled) return
      settled = true
      resolve(result)
    }

    const recognition = new Ctor()
    active = recognition
    recognition.continuous = false
    recognition.interimResults = false
    recognition.lang = 'en-US'
    recognition.onresult = event => {
      settle({ kind: 'transcript', transcript: event.results[0]?.[0]?.transcript ?? '' })
    }
    recognition.onerror = event => {
      settle({ kind: 'error', message: event.error ?? 'unknown' })
    }
    recognition.onend = () => {
      active = null
      settle({ kind: 'error', message: 'ended with no result' })
    }
    try {
      recognition.start()
    } catch (e) {
      settle({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
    }
  })
}

export function stopListening() {
  active?.stop()
  active = null
}
