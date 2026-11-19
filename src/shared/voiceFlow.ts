// The voice flow's decisions (G2-169), out of features/chat/tool.ts so they
// can be tested on the PC. tool.ts owns the state and the screen; it builds a
// VoiceState snapshot from its variables and asks these functions what to
// do. Every rule here was a bug found on the glasses first:
// - a phone screen request in the middle of a question lost the question;
// - an accidental long press over an answer started a recording (G2-161);
// - "Hey Jarvis" must not need the long-press confirmation;
// - the auto-send countdown has to follow real time, not frame counts (G2-162).

export type VoiceState = {
  // Recording from the mic right now.
  listening: boolean
  // Between the tap that ends a recording and its transcript.
  transcribing: boolean
  // Between the transcript and the request going out (a count: nested).
  preparing: number
  // A question of the chat on screen is waiting on the model.
  waitingHere: boolean
}

// Recording, transcribing, preparing or waiting: the screen must not switch
// under it, or the question is lost.
export function isBusy(s: VoiceState): boolean {
  return s.listening || s.transcribing || s.preparing > 0 || s.waitingHere
}

// Whether a new recording may start: never over a recording or a
// transcription; over an answer still arriving it may (a follow-up, G2-149).
export function canListen(s: VoiceState): boolean {
  return !s.listening && !s.transcribing && (s.preparing === 0 || s.waitingHere)
}

export const FOLLOW_UP_CONFIRM_MS = 4000

export type LongPressInput = {
  now: number
  // Started by "Hey Jarvis": deliberate, never confirmed.
  viaWake: boolean
  // The chat on screen already has messages (so this is a follow-up).
  hasMessages: boolean
  // Until when an earlier long press armed the confirmation (0: not armed).
  armedUntil: number
}

export type LongPressDecision =
  | { kind: 'record' }
  // Show "Long-press again to ask" until this time.
  | { kind: 'confirm'; armedUntil: number }
  | { kind: 'ignore' }

// A long press (or wake) in a chat (G2-161).
export function onLongPress(s: VoiceState, input: LongPressInput): LongPressDecision {
  if (!canListen(s)) return { kind: 'ignore' }
  if (input.viaWake || !input.hasMessages) return { kind: 'record' }
  if (input.now < input.armedUntil) return { kind: 'record' }
  return { kind: 'confirm', armedUntil: input.now + FOLLOW_UP_CONFIRM_MS }
}

export type PhoneRequest = {
  // The chat the phone wants on the glasses; null for the chat list.
  wanted: string | null
  // The chat on the glasses; null for a new chat not yet asked, or the list.
  current: string | null
  atPicker: boolean
}

// The phone asking the glasses for a screen (G2-69): 'ignore' while busy
// (the companion follows the glasses back), 'stay' when it is already there.
export function onPhoneRequest(s: VoiceState, r: PhoneRequest): 'ignore' | 'stay' | 'switch' {
  if (isBusy(s)) return 'ignore'
  if (r.wanted === r.current && (r.wanted !== null || r.atPicker)) return 'stay'
  return 'switch'
}

// Seconds left before auto-send (G2-161, G2-164): the full time while talking
// or before any speech, counting down in real time while quiet. null when
// auto-send is off.
export function autoSendCountdown(
  autoSendSeconds: number,
  heardSpeech: boolean,
  quietMs: number,
): number | null {
  if (autoSendSeconds <= 0) return null
  if (!heardSpeech) return autoSendSeconds
  return Math.max(1, Math.ceil((autoSendSeconds * 1000 - quietMs) / 1000))
}

// THE HINT ROW (G2-178): one line at the bottom of every Jarvis text screen
// that says what the gestures do right now, so a tap is never a guess. One
// place for it, instead of notes scattered over the status bar.
export type HintScreen =
  'empty' | 'listening' | 'transcribing' | 'thinking' | 'typing' | 'paused' | 'answer' | 'error'

export type HintInput = {
  screen: HintScreen
  // Seconds before auto-send while listening, null when off.
  countdown: number | null
  // The answer has a code view.
  hasCode: boolean
  // The chat has earlier questions, a swipe up from the top (G2-179).
  earlier: boolean
  // A long press over the answer asked for a second one (G2-161).
  armed: boolean
}

const GAP = '   '

export function hintFor(h: HintInput): string {
  switch (h.screen) {
    case 'listening':
      return h.countdown !== null ? `sending in ${h.countdown}s${GAP}tap: send now` : 'tap: send'
    // Nothing works while transcribing (canListen is false): say so.
    case 'transcribing':
      return 'one moment...'
    // A long press over a question still being answered asks a follow-up.
    case 'thinking':
      return 'hold: ask'
    case 'typing':
      return `tap: pause${GAP}swipe down: skip to end`
    case 'paused':
      return `tap: continue${GAP}swipe: read`
    case 'error':
      return `tap: retry${GAP}hold: ask again`
    case 'empty':
      return 'hold: ask'
    case 'answer':
      if (h.armed) return 'hold again: ask a follow-up'
      return [
        h.hasCode ? 'tap: code' : null,
        'hold: ask',
        h.earlier ? 'up: earlier' : null,
        'double-tap: back',
      ]
        .filter(Boolean)
        .join(h.hasCode && h.earlier ? '  ' : GAP)
  }
}

// The gesture card (G2-183): "Hey Jarvis, help". The same gestures the hint
// row names, all on one screen.
export const GESTURE_CARD = [
  'Gestures',
  'hold: ask a question (hold twice over an answer)',
  'tap: send / pause / continue / open code',
  'swipe: read on; swipe up at the top: earlier questions',
  'double-tap: back (answer, list, launcher)',
  '"Hey Jarvis": ask without touching',
  'say "go back", "go home", "scroll down", "new python chat"',
].join('\n')

// Length in ms of a 16-bit mono PCM frame (G2-162): measured, never assumed.
export function frameMs(bytes: number, sampleRate: number): number {
  return (bytes / 2 / sampleRate) * 1000
}
