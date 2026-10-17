import type { Tool } from '../../core/tool'
import { openMic } from '../../core/mic'
import { engineDescription, transcribe } from '../../core/whisper'
import { setContent } from '../../platform/page'
import { status } from '../../platform/bridge'
import { concat, toFloat32 } from '../../shared/pcm'
import { rmsLevel } from '../../shared/endpoint'
import { isSilenceHallucination, stripNonSpeech } from '../../shared/transcript'
import { createSegmenter, type Segment } from './segmenter'

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

export type LiveLine = { speaker: string; text: string; at: number }

const MAX_WAITING = 3
const REDRAW_MS = 1000
// Roughly one glasses screen of transcript. Every content update resets
// scroll (docs/platform.md), so the screen only ever shows the newest
// lines, newest at the bottom, and never needs scrolling.
const SCREEN_CHARS = 300

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
  const shown: string[] = []
  let chars = 0
  for (let i = lines.length - 1; i >= 0 && chars < SCREEN_CHARS; i--) {
    const line = `${label(lines[i].speaker)}${lines[i].text}`
    shown.unshift(line)
    chars += line.length
  }
  let body = shown.join('\n')
  if (body.length > SCREEN_CHARS) body = `...${body.slice(body.length - SCREEN_CHARS)}`
  if (!body) body = 'Listening to the conversation...\n\n(double-tap to end)'
  return `${header}\n\n${body}`
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
      redraw()
    })
    .catch(e => status(`Live: transcription failed (${e instanceof Error ? e.message : e})`))
    .finally(() => {
      transcribing = false
      transcribeNext(mySession)
    })
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

function startRedraw() {
  if (redrawTimer !== null) return
  redrawTimer = setInterval(redraw, REDRAW_MS)
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
