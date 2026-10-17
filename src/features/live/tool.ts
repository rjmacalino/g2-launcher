import type { Tool } from '../../core/tool'
import { openMic } from '../../core/mic'
import { engineDescription, transcribe } from '../../core/whisper'
import { setContent } from '../../platform/page'
import { status } from '../../platform/bridge'
import { concat, toFloat32 } from '../../shared/pcm'
import { rmsLevel } from '../../shared/endpoint'
import { isSilenceHallucination, stripNonSpeech } from '../../shared/transcript'
import { createSegmenter, type Segment } from './segmenter'
import { converse } from '../../core/gemini'
import { getAboutMe, getApiKey } from '../../core/geminiSettings'
import { conversationDigest } from '../../core/assistantContext'
import {
  CUE_INSTRUCTION,
  CUE_MAX_TOKENS,
  createCuePolicy,
  parseCue,
  transcriptForCue,
} from './cues'
import { getPrepNotes } from './settings'

// Jarvis Live (G2-65): the third Jarvis mode from docs/roadmap.md's Vision
// - a better Conversate. While open, it listens to the conversation the
// wearer is having and keeps a live transcript on the glasses. This first
// step is transcription only; Gemini cues (G2-66) and a saved summary
// Jarvis can be asked about later (G2-67) build on it.
//
// The mic stream is cut into utterances at natural pauses (segmenter.ts)
// and each is transcribed on its own through core/whisper.ts - in the
// worker when it works, so Whisper never blocks taps. Silence is never
// transcribed. If speech arrives faster than Whisper can keep up, the
// oldest waiting utterance is dropped and marked, rather than the
// transcript falling further and further behind the conversation.
//
// Lines are labelled You/Them when the glasses say who is speaking (their
// speakerRole), and left unlabelled when they do not know.
//
// Cues (G2-66): below the transcript, one short line from Gemini when it
// has something worth saying - see cues.ts for what it is told and when it
// is asked. A tap asks for one right now.

export type LiveLine = { speaker: string; text: string; at: number }

const MAX_WAITING = 3
const REDRAW_MS = 1000
// Roughly one glasses screen of transcript. Every content update resets
// scroll (docs/platform.md), so the screen only ever shows the newest
// lines, newest at the bottom, and never needs scrolling.
const SCREEN_CHARS = 300
// Less transcript when a cue is showing, so both fit one screen.
const SCREEN_CHARS_WITH_CUE = 200
// A cue this old is about a moment that has passed.
const CUE_EXPIRES_MS = 60_000
// The same short rule Jarvis uses between question and answer (U+2500,
// in the firmware font - docs/platform.md's glyph table).
const DIVIDER = '\u2500'.repeat(12)

type Cue = { text: string; at: number }

let releaseMic: (() => void) | null = null
let segmenter: ReturnType<typeof createSegmenter> | null = null
let waiting: Segment[] = []
let transcribing = false
let dropped = 0
let lines: LiveLine[] = []
let startedAt = 0
let redrawTimer: ReturnType<typeof setInterval> | null = null
let session = 0
let lastScreen = ''
// The loudest 100 ms in the last second, against the room's quiet level:
// shown on the Live screen so a wearer can see at once whether speech is
// reaching it, and how far above the room it is - the numbers its
// thresholds still need tuning against on real hardware.
let recentLoudest = 0
let shownLoudest = 0

let policy = createCuePolicy()
let cue: Cue | null = null
// Shown in the cue area instead of a cue: "Thinking..." while a tap's
// request is out, or why there can be no cues at all.
let cueNote = ''
let apiKey: string | null = null
let aboutMe: string | null = null
let prepNotes = ''

export function liveLines(): readonly LiveLine[] {
  return lines
}

function label(speaker: string): string {
  if (speaker === 'self') return 'You: '
  if (speaker === 'other') return 'Them: '
  return ''
}

function clock(ms: number): string {
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function render(): string {
  const level = segmenter?.level()
  const state = level?.speaking
    ? 'speech'
    : transcribing || waiting.length > 0
      ? 'writing'
      : 'quiet'
  const ratio = level && level.floor > 0 ? shownLoudest / level.floor : 0
  const header = `Live ${clock(Date.now() - startedAt)} - ${state} (${ratio.toFixed(1)}x room)`
  const now = Date.now()
  if (cue && now - cue.at > CUE_EXPIRES_MS) cue = null
  const cueText = cue ? `> ${cue.text} (${Math.round((now - cue.at) / 1000)}s)` : cueNote
  const budget = cueText ? SCREEN_CHARS_WITH_CUE : SCREEN_CHARS
  const shown: string[] = []
  let chars = 0
  for (let i = lines.length - 1; i >= 0 && chars < budget; i--) {
    const line = `${label(lines[i].speaker)}${lines[i].text}`
    shown.unshift(line)
    chars += line.length
  }
  let body = shown.join('\n')
  if (body.length > budget) body = `...${body.slice(body.length - budget)}`
  if (!body) body = 'Listening to the conversation...\n\n(tap for a cue, double-tap to end)'
  return cueText ? `${header}\n\n${body}\n${DIVIDER}\n${cueText}` : `${header}\n\n${body}`
}

function redraw() {
  shownLoudest = recentLoudest
  recentLoudest = 0
  const screen = render()
  if (screen === lastScreen) return
  lastScreen = screen
  setContent(screen)
}

function transcribeNext(mySession: number) {
  if (transcribing || mySession !== session) return
  const segment = waiting.shift()
  if (!segment) return
  transcribing = true
  transcribe(toFloat32(concat(segment.frames)))
    .then(raw => {
      if (mySession !== session) return
      const text = stripNonSpeech(raw)
      if (!text || isSilenceHallucination(text)) return
      if (dropped > 0) {
        lines.push({ speaker: 'unknown', text: '(missed a bit)', at: segment.endedAt })
        dropped = 0
      }
      lines.push({ speaker: segment.speaker, text, at: segment.endedAt })
      if (policy.onLine(text, Date.now())) void askForCue(mySession)
      redraw()
    })
    .catch(e => status(`Live: transcription failed (${e instanceof Error ? e.message : e})`))
    .finally(() => {
      transcribing = false
      transcribeNext(mySession)
    })
}

async function askForCue(mySession: number) {
  if (mySession !== session) return
  if (!apiKey) {
    cueNote = 'No cues: add a Gemini key in Jarvis on the companion page.'
    return
  }
  if (lines.length === 0) {
    cueNote = ''
    return
  }
  const askedAt = Date.now()
  policy.started(askedAt)
  const background = [
    prepNotes && `Prep notes from the wearer for this conversation: ${prepNotes}`,
    conversationDigest(),
  ]
    .filter(Boolean)
    .join('\n\n')
  try {
    const reply = await converse(apiKey, [{ role: 'user', text: transcriptForCue(lines) }], {
      instruction: CUE_INSTRUCTION,
      maxOutputTokens: CUE_MAX_TOKENS,
      aboutMe,
      background,
    })
    if (mySession !== session) return
    if (reply.kind === 'answer') {
      const text = parseCue(reply.text)
      if (text) cue = { text, at: Date.now() }
      const took = ((Date.now() - askedAt) / 1000).toFixed(1)
      status(`Live: cue in ${took}s${text ? '' : ' (nothing to say)'}`)
      cueNote = ''
    } else if (reply.kind === 'error') {
      status(`Live: cue failed (${reply.message})`)
      cueNote = cue ? '' : `(cue failed: ${reply.message})`
    }
  } finally {
    policy.finished()
    if (mySession === session) redraw()
  }
}

function onSegment(segment: Segment, mySession: number) {
  if (waiting.length >= MAX_WAITING) {
    waiting.shift()
    dropped += 1
  }
  waiting.push(segment)
  transcribeNext(mySession)
}

async function startLive() {
  stopLive()
  const mySession = ++session
  lines = []
  waiting = []
  dropped = 0
  startedAt = Date.now()
  policy = createCuePolicy()
  cue = null
  cueNote = ''
  // Read once per session, not per cue: a cue waits on nothing but Gemini.
  ;[apiKey, aboutMe, prepNotes] = await Promise.all([getApiKey(), getAboutMe(), getPrepNotes()])
  if (mySession !== session) return
  segmenter = createSegmenter()
  const release = await openMic((pcm, speaker) => {
    if (mySession !== session || !segmenter) return
    const rms = rmsLevel(toFloat32(pcm))
    recentLoudest = Math.max(recentLoudest, rms)
    const segment = segmenter.push(pcm, rms, speaker, Date.now())
    if (segment) onSegment(segment, mySession)
  })
  if (mySession !== session) {
    release?.()
    return
  }
  if (!release) {
    setContent('Could not start the glasses microphone.\n\nDouble-tap to go back.')
    return
  }
  releaseMic = release
  status(`Live: listening (Whisper via ${engineDescription()})`)
  redraw()
  startRedraw()
}

function tick() {
  if (releaseMic && policy.onTick(Date.now())) void askForCue(session)
  redraw()
}

function startRedraw() {
  if (redrawTimer !== null) return
  redrawTimer = setInterval(tick, REDRAW_MS)
}

function stopRedraw() {
  if (redrawTimer !== null) clearInterval(redrawTimer)
  redrawTimer = null
}

function stopLive() {
  session++
  stopRedraw()
  releaseMic?.()
  releaseMic = null
  segmenter = null
  waiting = []
  transcribing = false
}

export const liveTool: Tool = {
  name: 'Jarvis Live',
  // A whole conversation's transcript is on the line; an accidental
  // double-tap should not end it.
  confirmOnExit: () => true,
  confirmPrompt: () => 'End Jarvis Live?',
  initialContent: () => {
    lastScreen = 'Starting the microphone...'
    return lastScreen
  },
  onOpen: () => {
    void startLive()
  },
  onClose: stopLive,
  // Ask for a cue now - "what do I say?" - instead of waiting for the next
  // question or timed check.
  onTap: () => {
    if (!releaseMic) return
    cueNote = apiKey && !cue ? 'Thinking...' : cueNote
    if (policy.onTap(Date.now())) void askForCue(session)
    redraw()
  },
  // The mic stops in the background anyway (core/mic.ts re-arms it); the
  // clock just does not need to tick for a page nobody is looking at.
  onSuspend: stopRedraw,
  onResume: () => {
    if (!releaseMic) return
    lastScreen = ''
    redraw()
    startRedraw()
  },
}
