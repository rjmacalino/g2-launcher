import type { Tool } from '../../core/tool'
import { openMic } from '../../core/mic'
import { engineDescription, transcribe } from '../../core/whisper'
import { setContent } from '../../platform/page'
import { status } from '../../platform/bridge'
import { concat, toFloat32 } from '../../shared/pcm'
import { rmsLevel } from '../../shared/endpoint'
import { positionLabel } from '../../shared/position'
import { isSilenceHallucination, stripNonSpeech } from '../../shared/transcript'
import { createSegmenter, type Segment } from '../live/segmenter'
import { getAboutMe } from '../../core/geminiSettings'
import { askModel } from '../../core/llm'
import { getLlmConfig, type LlmConfig } from '../../core/llmSettings'
import { setStatusNote } from '../../core/statusNote'
import {
  PAGE_INNER_WIDTH,
  REBUILD_MAX_CHARS,
  lowerPageLimit,
  paginate,
  type Page,
} from '../chat/paging'
import { movePaged, type Win } from '../chat/viewer'
import { getProfile } from './settings'
import {
  FORCED_NOTE,
  PARAKEET_INSTRUCTION,
  parseAnswer,
  profileBackground,
  transcriptFor,
  triggersAnswer,
  type HeardLine,
} from './answer'

// Parakeet (G2-128): a launcher tool that listens through the glasses
// microphone and, once the other person has finished asking something,
// shows an answer to it. The listening is Wingman's (mic, utterance
// segmenter, Whisper); the answer comes from the model chosen for Jarvis on
// the phone, since depth matters more than speed here. The answer is paged
// like Jarvis's: swipe at an edge for the next page, back lands on the last
// screenful above.
//
// Tap asks again now (about everything heard so far), long press pauses and
// resumes the listening, double-tap ends it.

const MAX_WAITING = 3
const REDRAW_MS = 1000
// Wait this long after the last thing the other person said, so a long
// question that arrives as several utterances is answered once, whole.
const QUIET_BEFORE_ASKING_MS = 3000
const SCREEN_CHARS = 400

let releaseMic: (() => void) | null = null
let paused = false
let segmenter: ReturnType<typeof createSegmenter> | null = null
let waiting: Segment[] = []
let transcribing = false
let lines: HeardLine[] = []
let session = 0
let redrawTimer: ReturnType<typeof setInterval> | null = null
let askTimer: ReturnType<typeof setTimeout> | null = null
let lastScreen = ''
let llm: LlmConfig | null = null
let aboutMe: string | null = null
let profile = ''
let asking = false
let startedAt = 0
// How many heard lines the model has already been asked about.
let handled = 0

let answer: string | null = null
let pages: Page[] = []
let pageIndex = 0
let pageWin: Win | null = null

function clock(ms: number): string {
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function listeningScreen(): string {
  const header = paused
    ? 'Parakeet - PAUSED (hold to resume)'
    : `Parakeet ${clock(Date.now() - startedAt)} - ${asking ? 'thinking...' : 'listening'}`
  const shown: string[] = []
  let chars = 0
  for (let i = lines.length - 1; i >= 0 && chars < SCREEN_CHARS; i--) {
    const line = `${lines[i].speaker === 'self' ? 'Me: ' : ''}${lines[i].text}`
    shown.unshift(line)
    chars += line.length
  }
  const body = shown.join('\n') || 'Listening...\n\n(tap: answer now, hold: pause, double-tap: end)'
  return `${header}\n\n${body}`
}

// What is on the glasses: the page of the answer being read, or the live
// transcript while there is no answer yet.
function screen(): string {
  if (answer === null || pages.length === 0) return listeningScreen()
  const text = pages[pageIndex].text
  if (!pageWin) return text
  return text.split(/\n/).slice(pageWin.start, pageWin.end).join('\n')
}

function updateNote(): void {
  setStatusNote(answer === null ? null : (positionLabel(pageIndex, pages.length) ?? 'Answer'))
}

async function put(text: string): Promise<void> {
  const ok = await setContent(text)
  if (ok || text.length <= REBUILD_MAX_CHARS || !lowerPageLimit() || answer === null) return
  // The glasses refused a long update: cut the answer into shorter pages.
  pages = paginate(answer, PAGE_INNER_WIDTH)
  pageIndex = 0
  pageWin = null
  updateNote()
  await setContent(pages[0].text)
}

function redraw(): void {
  const text = screen()
  if (text === lastScreen) return
  lastScreen = text
  void put(text)
}

function showAnswer(text: string): void {
  answer = text
  pages = paginate(text, PAGE_INNER_WIDTH)
  pageIndex = 0
  pageWin = null
  updateNote()
  lastScreen = ''
  redraw()
}

async function askNow(mySession: number, forced = false): Promise<void> {
  if (mySession !== session || asking || lines.length === 0) return
  if (!llm) {
    status('Parakeet: add an AI key in Jarvis on the companion page')
    return
  }
  asking = true
  redraw()
  const began = Date.now()
  const upTo = lines.length
  try {
    const reply = await askModel(
      llm,
      [{ role: 'user', text: transcriptFor(lines, forced ? 0 : handled) }],
      {
        instruction: forced ? `${PARAKEET_INSTRUCTION} ${FORCED_NOTE}` : PARAKEET_INSTRUCTION,
        aboutMe,
        background: profileBackground(profile),
      },
    )
    if (mySession !== session) return
    if (reply.kind === 'answer') {
      // Whatever the answer, those lines are dealt with: no second answer
      // to the same question.
      handled = upTo
      const text = parseAnswer(reply.text)
      status(
        `Parakeet: ${text ? 'answer' : 'nothing to answer'} in ${((Date.now() - began) / 1000).toFixed(1)}s`,
      )
      if (text) showAnswer(text)
    } else if (reply.kind === 'error') {
      status(`Parakeet: failed (${reply.message})`)
    }
  } finally {
    asking = false
    if (mySession === session) redraw()
  }
}

function scheduleAsk(mySession: number): void {
  if (askTimer !== null) clearTimeout(askTimer)
  askTimer = setTimeout(() => {
    askTimer = null
    // Still being spoken or written down: wait for the end of it.
    if (transcribing || waiting.length > 0 || segmenter?.level().speaking) {
      scheduleAsk(mySession)
      return
    }
    void askNow(mySession)
  }, QUIET_BEFORE_ASKING_MS)
}

function transcribeNext(mySession: number): void {
  if (transcribing || mySession !== session) return
  const segment = waiting.shift()
  if (!segment) return
  transcribing = true
  transcribe(toFloat32(concat(segment.frames)))
    .then(raw => {
      if (mySession !== session) return
      const text = stripNonSpeech(raw)
      if (!text || isSilenceHallucination(text)) return
      const line = { speaker: segment.speaker, text, at: segment.endedAt }
      lines.push(line)
      // The wearer talking while an answer is due gives the model more to
      // go on (are they answering? thinking?), so the wait starts over.
      if (triggersAnswer(line) || (line.speaker === 'self' && askTimer !== null)) {
        scheduleAsk(mySession)
      }
      redraw()
    })
    .catch(e => status(`Parakeet: transcription failed (${e instanceof Error ? e.message : e})`))
    .finally(() => {
      transcribing = false
      transcribeNext(mySession)
    })
}

function onSegment(segment: Segment, mySession: number): void {
  if (waiting.length >= MAX_WAITING) waiting.shift()
  waiting.push(segment)
  transcribeNext(mySession)
}

function listen(mySession: number): Promise<(() => void) | null> {
  return openMic((pcm, speaker) => {
    if (mySession !== session || !segmenter || paused) return
    const segment = segmenter.push(pcm, rmsLevel(toFloat32(pcm)), speaker, Date.now())
    if (segment) onSegment(segment, mySession)
  })
}

async function start(): Promise<void> {
  stop()
  const mySession = ++session
  lines = []
  handled = 0
  waiting = []
  answer = null
  pages = []
  startedAt = Date.now()
  ;[llm, aboutMe, profile] = await Promise.all([getLlmConfig('phone'), getAboutMe(), getProfile()])
  if (mySession !== session) return
  segmenter = createSegmenter()
  paused = false
  const release = await listen(mySession)
  if (mySession !== session) {
    release?.()
    return
  }
  if (!release) {
    void setContent('Could not start the glasses microphone.\n\nDouble-tap to go back.')
    return
  }
  releaseMic = release
  status(`Parakeet: listening (Whisper via ${engineDescription()})`)
  redraw()
  startRedraw()
}

async function togglePause(): Promise<void> {
  if (!segmenter) return
  const mySession = session
  if (!paused) {
    paused = true
    const rest = segmenter.flush(Date.now())
    if (rest) onSegment(rest, mySession)
    segmenter = createSegmenter()
    releaseMic?.()
    releaseMic = null
    redraw()
    return
  }
  const release = await listen(mySession)
  if (mySession !== session) {
    release?.()
    return
  }
  if (!release) return
  releaseMic = release
  paused = false
  redraw()
}

function startRedraw(): void {
  if (redrawTimer === null) redrawTimer = setInterval(redraw, REDRAW_MS)
}

function stopRedraw(): void {
  if (redrawTimer !== null) clearInterval(redrawTimer)
  redrawTimer = null
}

function stop(): void {
  session++
  stopRedraw()
  if (askTimer !== null) clearTimeout(askTimer)
  askTimer = null
  releaseMic?.()
  releaseMic = null
  segmenter = null
  waiting = []
  transcribing = false
  asking = false
  paused = false
  setStatusNote(null)
}

export const parakeetTool: Tool = {
  name: 'Parakeet',
  confirmOnExit: () => true,
  confirmPrompt: () => 'End Parakeet?',
  initialContent: () => {
    lastScreen = 'Starting the microphone...'
    return lastScreen
  },
  onOpen: () => {
    void start()
  },
  onClose: stop,
  onTap: () => {
    if (releaseMic && !paused) void askNow(session, true)
  },
  onLongPress: () => void togglePause(),
  // Called only for a swipe at a page's top (-1) or bottom (1) edge.
  onScroll: delta => {
    if (answer === null || pages.length === 0) return
    const next = movePaged(
      pages.map(p => p.text.split(/\n/).length),
      { page: pageIndex, win: pageWin },
      delta,
    )
    if (!next) return
    pageIndex = next.page
    pageWin = next.win
    updateNote()
    redraw()
  },
  onSuspend: () => {
    stopRedraw()
    setStatusNote(null)
  },
  onResume: () => {
    if (!releaseMic) return
    lastScreen = ''
    updateNote()
    redraw()
    startRedraw()
  },
}
