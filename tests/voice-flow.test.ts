import { describe, expect, it } from 'vitest'
import {
  FOLLOW_UP_CONFIRM_MS,
  autoSendCountdown,
  canListen,
  frameMs,
  hintFor,
  isBusy,
  onLongPress,
  onPhoneRequest,
  type VoiceState,
} from '../src/shared/voiceFlow'
import { createTurnDetector } from '../src/shared/endOfTurn'

// The voice flow's decisions (G2-169), each one a bug first found on the
// glasses this week.

const idle: VoiceState = { listening: false, transcribing: false, preparing: 0, waitingHere: false }
const listening = { ...idle, listening: true }
const transcribing = { ...idle, transcribing: true }
// The first question of a new chat: transcript in, request about to go out.
const preparingFirst = { ...idle, preparing: 1 }
// An answer still arriving for the chat on screen.
const answering = { ...idle, preparing: 1, waitingHere: true }

describe('busy and canListen', () => {
  it('is busy through every stage of a question', () => {
    expect(isBusy(idle)).toBe(false)
    for (const s of [listening, transcribing, preparingFirst, answering])
      expect(isBusy(s)).toBe(true)
  })

  it('never starts a recording over a recording or a transcription', () => {
    expect(canListen(listening)).toBe(false)
    expect(canListen(transcribing)).toBe(false)
    expect(canListen(preparingFirst)).toBe(false)
  })

  it('lets a follow-up start over an answer still arriving (G2-149)', () => {
    expect(canListen(answering)).toBe(true)
    expect(canListen(idle)).toBe(true)
  })
})

describe('phone screen requests (G2-156)', () => {
  it('ignores the phone sending the glasses to the list during the first question of a new chat', () => {
    // The bug: the phone could not find the new chat yet, fell back to the
    // list and asked the glasses for it; the question was dropped.
    const r = { wanted: null, current: 'new-chat-id', atPicker: false }
    expect(onPhoneRequest(preparingFirst, r)).toBe('ignore')
    expect(onPhoneRequest(answering, r)).toBe('ignore')
    expect(onPhoneRequest(listening, r)).toBe('ignore')
  })

  it('stays put when the phone asks for what is already shown, else switches when idle', () => {
    expect(onPhoneRequest(idle, { wanted: 'a', current: 'a', atPicker: false })).toBe('stay')
    expect(onPhoneRequest(idle, { wanted: null, current: null, atPicker: true })).toBe('stay')
    expect(onPhoneRequest(idle, { wanted: 'b', current: 'a', atPicker: false })).toBe('switch')
    // A new chat not yet asked (no id) is not the list.
    expect(onPhoneRequest(idle, { wanted: null, current: null, atPicker: false })).toBe('switch')
  })
})

describe('long press in a chat (G2-161)', () => {
  const press = (over: Partial<Parameters<typeof onLongPress>[1]> = {}, s = idle) =>
    onLongPress(s, { now: 1000, viaWake: false, hasMessages: true, armedUntil: 0, ...over })

  it('asks first over an answer, and records on a second press within the window', () => {
    const first = press()
    expect(first).toEqual({ kind: 'confirm', armedUntil: 1000 + FOLLOW_UP_CONFIRM_MS })
    const armedUntil = first.kind === 'confirm' ? first.armedUntil : 0
    expect(press({ now: 3000, armedUntil })).toEqual({ kind: 'record' })
  })

  it('asks again once the window has passed', () => {
    expect(press({ now: 9000, armedUntil: 5000 }).kind).toBe('confirm')
  })

  it('records at once in an empty chat and for "Hey Jarvis"', () => {
    expect(press({ hasMessages: false })).toEqual({ kind: 'record' })
    expect(press({ viaWake: true })).toEqual({ kind: 'record' })
  })

  it('does nothing over a recording or a transcription', () => {
    expect(press({}, listening)).toEqual({ kind: 'ignore' })
    expect(press({}, transcribing)).toEqual({ kind: 'ignore' })
  })
})

describe('auto-send countdown over real mic frames (G2-162, G2-164)', () => {
  it('measures frame length from bytes', () => {
    expect(frameMs(320, 16000)).toBe(10)
    expect(frameMs(3200, 16000)).toBe(100)
  })

  // Speech, then quiet, fed as 10 ms frames the way the glasses send them;
  // the countdown read once a second as the listening screen does.
  it('shows 20 while talking, counts down in real seconds while quiet, resets on speech', () => {
    const turn = createTurnDetector({
      initialFloor: 0.002,
      completePauseMs: 20_000,
      incompletePauseMs: 20_000,
    })
    const feed = (rms: number, seconds: number) => {
      for (let i = 0; i < seconds * 100; i++) turn.push(rms, null, frameMs(320, 16000))
    }
    const shown = () => autoSendCountdown(20, turn.heardSpeech(), turn.quietMs())

    expect(shown()).toBe(20)
    feed(0.2, 1)
    expect(shown()).toBe(20)
    feed(0.002, 5)
    expect(shown()).toBe(15)
    feed(0.2, 1)
    expect(shown()).toBe(20)
    feed(0.002, 19)
    expect(shown()).toBe(1)
  })

  it('shows nothing when auto-send is off', () => {
    expect(autoSendCountdown(0, true, 5000)).toBeNull()
  })
})

describe('hint row (G2-178)', () => {
  const hint = (over: Partial<Parameters<typeof hintFor>[0]>) =>
    hintFor({
      screen: 'answer',
      countdown: null,
      hasCode: false,
      earlier: false,
      armed: false,
      ...over,
    })

  it('says what a tap does in every state, and nothing that would not work', () => {
    expect(hint({ screen: 'listening' })).toBe('tap: send')
    expect(hint({ screen: 'listening', countdown: 17 })).toBe('sending in 17s   tap: send now')
    // A long press is ignored while transcribing (canListen is false).
    expect(hint({ screen: 'transcribing' })).not.toMatch(/hold|tap/)
    expect(hint({ screen: 'thinking' })).toBe('hold: ask')
    expect(hint({ screen: 'typing' })).toBe('tap: pause   swipe down: skip to end')
    expect(hint({ screen: 'paused' })).toBe('tap: continue   swipe: read')
    expect(hint({ screen: 'error' })).toBe('tap: retry   hold: ask again')
    expect(hint({ screen: 'empty' })).toBe('hold: ask')
  })

  it('offers the code view only when the answer has one, and the confirmation when armed', () => {
    expect(hint({})).toBe('hold: ask   double-tap: back')
    expect(hint({ hasCode: true })).toBe('tap: code   hold: ask   double-tap: back')
    expect(hint({ armed: true, hasCode: true })).toBe('hold again: ask a follow-up')
  })

  it('points to earlier questions when the chat has them (G2-179)', () => {
    expect(hint({ earlier: true })).toBe('hold: ask   up: earlier   double-tap: back')
    expect(hint({ earlier: true, hasCode: true })).toBe(
      'tap: code  hold: ask  up: earlier  double-tap: back',
    )
  })

  it('fits on one row', () => {
    const screens = [
      'listening',
      'transcribing',
      'thinking',
      'typing',
      'paused',
      'answer',
      'error',
      'empty',
    ] as const
    for (const screen of screens) {
      expect(
        hint({ screen, countdown: 20, hasCode: true, earlier: true }).length,
      ).toBeLessThanOrEqual(52)
    }
  })
})
