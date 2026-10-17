import type { Tool } from '../../core/tool'
import { openMic } from '../../core/mic'
import { engineDescription, transcribe } from '../../core/whisper'
import { setContent } from '../../platform/page'
import { status } from '../../platform/bridge'
import { concat, toFloat32 } from '../../shared/pcm'
import { rmsLevel } from '../../shared/endpoint'
import { isSilenceHallucination, stripNonSpeech } from '../../shared/transcript'
import { createSegmenter, type Segment } from './segmenter'
import { getAboutMe } from '../../core/geminiSettings'
import { askModel } from '../../core/llm'
import { getLlmConfig, type LlmConfig } from '../../core/llmSettings'
import { conversationDigest, saveConversation } from '../../core/assistantContext'
import {
  CUE_INSTRUCTION,
  CUE_MAX_TOKENS,
  createCuePolicy,
  parseCue,
  transcriptForCue,
} from './cues'
import { getPrepNotes } from './settings'
import {
  SUMMARY_INSTRUCTION,
  SUMMARY_MAX_TOKENS,
  storedTranscript,
  summaryRequest,
  summaryTitle,
} from './summary'

// Wingman (G2-65): the third Jarvis mode from docs/roadmap.md's Vision
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
//
// Ending it (G2-67) saves the conversation into Jarvis's history: a short
// record written by Gemini, with the transcript behind it - see
// summary.ts. Written in the background after the page has closed.

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
// Paused by a long press (G2-75): the mic is released - nothing is heard,
// nothing is sent - but the session, its transcript and its cues stay, and
// a second long press carries on. For the private moment mid-conversation.
let paused = false
let pausedAt = 0
let pausedMs = 0
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
// The AI chosen on the companion page, read once per session (G2-68).
let llm: LlmConfig | null = null
let aboutMe: string | null = null
let prepNotes = ''

export function liveLines(): readonly LiveLine[] {
  return lines
}

// Wingman as the phone sees it (G2-70): the companion's Live page
// shows the full transcript and cue history live, and can ask for a cue,
// while the glasses show the newest few lines.
export type LiveState = {
  running: boolean
  paused: boolean
  startedAt: number
  lines: readonly LiveLine[]
  cue: { text: string; at: number } | null
  cueNote: string
  hearing: 'speech' | 'writing' | 'quiet'
  // The loudest moment in the last second against the room's quiet level.
  levelRatio: number
}

const stateListeners = new Set<() => void>()

export function onLiveChange(fn: () => void): () => void {
  stateListeners.add(fn)
  return () => stateListeners.delete(fn)
}

function notifyState() {
  for (const fn of [...stateListeners]) fn()
}

export function getLiveState(): LiveState {
  const level = segmenter?.level()
  return {
    running: segmenter !== null,
    paused,
    startedAt,
    lines,
    cue,
    cueNote,
    hearing: level?.speaking ? 'speech' : transcribing || waiting.length > 0 ? 'writing' : 'quiet',
    levelRatio: level && level.floor > 0 ? shownLoudest / level.floor : 0,
  }
}

// "What do I say?" - the same as a tap on the glasses.
export function askCueNow(): void {
  if (!releaseMic || paused) return
  cueNote = llm && !cue ? 'Thinking...' : cueNote
  if (policy.onTap(Date.now())) void askForCue(session)
  redraw()
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
  const elapsed = (paused ? pausedAt : Date.now()) - startedAt - pausedMs
  const header = paused
    ? `Wingman ${clock(elapsed)} - PAUSED, not listening (hold to resume)`
    : `Wingman ${clock(elapsed)} - ${state} (${ratio.toFixed(1)}x room)`
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
  if (!body)
    body = 'Listening to the conversation...\n\n(tap for a cue, hold to pause, double-tap to end)'
  return cueText ? `${header}\n\n${body}\n${DIVIDER}\n${cueText}` : `${header}\n\n${body}`
}

function redraw() {
  shownLoudest = recentLoudest
  recentLoudest = 0
  notifyState()
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
    .catch(e => status(`Wingman: transcription failed (${e instanceof Error ? e.message : e})`))
    .finally(() => {
      transcribing = false
      transcribeNext(mySession)
    })
}

async function askForCue(mySession: number) {
  if (mySession !== session) return
  if (!llm) {
    cueNote = 'No cues: add an AI key in Jarvis on the companion page.'
    return
  }
  if (lines.length === 0) {
    cueNote = ''
    return
  }
  const askedAt = Date.now()
  policy.started(askedAt)
  const background = [prepNotesBackground(prepNotes), conversationDigest()]
    .filter(Boolean)
    .join('\n\n')
  try {
    const reply = await askModel(llm, [{ role: 'user', text: transcriptForCue(lines) }], {
      effort: 'low',
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
      status(`Wingman: cue in ${took}s${text ? '' : ' (nothing to say)'}`)
      cueNote = ''
    } else if (reply.kind === 'error') {
      status(`Wingman: cue failed (${reply.message})`)
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

function listen(mySession: number): Promise<(() => void) | null> {
  return openMic((pcm, speaker) => {
    if (mySession !== session || !segmenter || paused) return
    const rms = rmsLevel(toFloat32(pcm))
    recentLoudest = Math.max(recentLoudest, rms)
    const segment = segmenter.push(pcm, rms, speaker, Date.now())
    if (segment) onSegment(segment, mySession)
  })
}

export async function togglePause(): Promise<void> {
  if (!segmenter) return
  const mySession = session
  if (!paused) {
    paused = true
    pausedAt = Date.now()
    // Whatever was mid-sentence goes to Whisper; nothing after it is heard.
    const rest = segmenter.flush(Date.now())
    if (rest) onSegment(rest, mySession)
    segmenter = createSegmenter()
    releaseMic?.()
    releaseMic = null
    status('Wingman: paused')
    redraw()
    return
  }
  const release = await listen(mySession)
  if (mySession !== session) {
    release?.()
    return
  }
  if (!release) {
    status('Wingman: could not resume the microphone')
    return
  }
  releaseMic = release
  pausedMs += Date.now() - pausedAt
  paused = false
  status('Wingman: listening again')
  redraw()
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
  ;[llm, aboutMe, prepNotes] = await Promise.all([
    getLlmConfig('wingman'),
    getAboutMe(),
    getPrepNotes(),
  ])
  if (mySession !== session) return
  segmenter = createSegmenter()
  paused = false
  pausedMs = 0
  const release = await listen(mySession)
  if (mySession !== session) {
    release?.()
    return
  }
  if (!release) {
    setContent('Could not start the glasses microphone.\n\nDouble-tap to go back.')
    return
  }
  releaseMic = release
  status(`Wingman: listening (Whisper via ${engineDescription()})`)
  redraw()
  startRedraw()
}

function tick() {
  if (releaseMic && !paused && policy.onTick(Date.now())) void askForCue(session)
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

function prepNotesBackground(notes: string): string {
  return notes ? `Prep notes from the wearer for this conversation: ${notes}` : ''
}

async function saveSession(
  snapshot: readonly LiveLine[],
  began: number,
  key: LlmConfig | null,
  me: string | null,
  notes: string,
) {
  let summary: string | null = null
  if (key) {
    status('Wingman: writing the conversation summary')
    const reply = await askModel(key, [{ role: 'user', text: summaryRequest(snapshot) }], {
      effort: 'low',
      instruction: SUMMARY_INSTRUCTION,
      maxOutputTokens: SUMMARY_MAX_TOKENS,
      aboutMe: me,
      background: prepNotesBackground(notes),
    })
    if (reply.kind === 'answer') summary = reply.text.trim()
    else if (reply.kind === 'error') status(`Wingman: summary failed (${reply.message})`)
  }
  const saved = await saveConversation({
    title: summaryTitle(summary, began),
    messages: [
      {
        role: 'user',
        text: `Transcript of a conversation from Wingman:\n${storedTranscript(snapshot)}`,
        timestamp: began,
      },
      {
        role: 'model',
        text:
          summary ??
          'No summary - add an AI key in Jarvis on the companion page to get one next time.',
        timestamp: Date.now(),
      },
    ],
  })
  status(
    saved
      ? `Live: conversation saved to Jarvis${summary ? ' with a summary' : ''}`
      : 'Live: could not save the conversation',
  )
}

// Leaving Live: stop listening at once, then save what was heard.
function endSession() {
  const snapshot = lines
  const began = startedAt
  const key = llm
  const me = aboutMe
  const notes = prepNotes
  stopLive()
  if (snapshot.length > 0) void saveSession(snapshot, began, key, me, notes)
}

function stopLive() {
  paused = false
  queueMicrotask(notifyState)
  session++
  stopRedraw()
  releaseMic?.()
  releaseMic = null
  segmenter = null
  waiting = []
  transcribing = false
}

export const liveTool: Tool = {
  name: 'Wingman',
  // A whole conversation's transcript is on the line; an accidental
  // double-tap should not end it.
  confirmOnExit: () => true,
  confirmPrompt: () => 'End Wingman?',
  initialContent: () => {
    lastScreen = 'Starting the microphone...'
    return lastScreen
  },
  onOpen: () => {
    void startLive()
  },
  onClose: endSession,
  // Ask for a cue now - "what do I say?" - instead of waiting for the next
  // question or timed check.
  onTap: askCueNow,
  // Pause and resume (G2-75): safe, reversible, and the one thing worth a
  // gesture mid-conversation that a tap (a cue) does not already do.
  onLongPress: () => void togglePause(),
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
