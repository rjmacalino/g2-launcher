import type { Tool } from '../../core/tool'
import { openMic } from '../../core/mic'
import { engineDescription, transcribe } from '../../core/whisper'
import { LIST_HEADER_ROWS, setContent, setListHeader } from '../../platform/page'
import { status } from '../../platform/bridge'
import { concat, toFloat32 } from '../../shared/pcm'
import { rmsLevel } from '../../shared/endpoint'
import { positionLabel } from '../../shared/position'
import { questionLine } from '../../shared/questionKeywords'
import { isSilenceHallucination, stripNonSpeech } from '../../shared/transcript'
import { createSegmenter, type Segment } from '../live/segmenter'
import { getAboutMe } from '../../core/geminiSettings'
import { askModel } from '../../core/llm'
import { getLlmConfig, type LlmConfig } from '../../core/llmSettings'
import { requestRebuild } from '../../core/rebuild'
import { setStatusNote } from '../../core/statusNote'
import {
  PAGE_INNER_WIDTH,
  REBUILD_MAX_CHARS,
  lowerPageLimit,
  paginate,
  rebuildSafe,
  wrapLines,
  type Page,
} from '../chat/paging'
import { movePaged, type Win } from '../chat/viewer'
import { getProfile } from './settings'
import {
  PARAKEET_INSTRUCTION,
  parseAnswer,
  profileBackground,
  splitQuestion,
  transcriptFor,
  triggersAnswer,
  type Answered,
  type HeardLine,
} from './answer'

// Parakeet (G2-128, G2-132): a launcher tool that listens through the
// glasses microphone and answers, as the wearer, the questions the other
// person asks. The listening is Wingman's (mic, utterance segmenter,
// Whisper); the answers come from the model chosen for Jarvis on the phone,
// since depth matters more than speed here.
//
// Two screens, per RJ's design:
// - the list: every question heard so far, newest on top and numbered
//   ("5. Who is better, LeBron or MJ?"), picked the way an app is picked
//   in the launcher. Listening runs here. Tap opens a question's answer;
//   double-tap ends Parakeet; long press pauses and resumes listening.
// - the answer: paged like Jarvis's (swipe at an edge for the next page,
//   back lands on the last screenful above). The mic is off here - the
//   wearer is reading the answer aloud and must not be heard as a new
//   question. Double-tap goes back to the list and listening resumes.

const MAX_WAITING = 3
// Wait this long after the last thing the other person said, so a long
// question that arrives as several utterances is answered once, whole.
const QUIET_BEFORE_ASKING_MS = 3000
const MAX_WAIT_FOR_QUIET_MS = 12_000
// The firmware's list item length (the same limit Notes keeps to).
const ITEM_MAX_CHARS = 64

let releaseMic: (() => void) | null = null
// Long press: the wearer turned listening off on the list.
let paused = false
let segmenter: ReturnType<typeof createSegmenter> | null = null
let waiting: Segment[] = []
let transcribing = false
let lines: HeardLine[] = []
let session = 0
let askTimer: ReturnType<typeof setTimeout> | null = null
let llm: LlmConfig | null = null
let aboutMe: string | null = null
let profile = ''
let asking = false
// How many heard lines the model has already been asked about.
let handled = 0

// Oldest first; the list shows them the other way round.
let answered: Answered[] = []
// The question whose answer is on screen, or null on the list.
let reading: number | null = null
let pages: Page[] = []
let pageIndex = 0
let pageWin: Win | null = null

function updateNote(): void {
  if (reading !== null) {
    setStatusNote(positionLabel(pageIndex, pages.length) ?? `Answer ${reading + 1}`)
    return
  }
  setStatusNote(paused ? 'Paused - hold to listen' : asking ? 'Thinking...' : 'Listening')
}

function pageText(): string {
  const text = pages[pageIndex]?.text ?? ''
  if (!pageWin) return text
  return text.split(/\n/).slice(pageWin.start, pageWin.end).join('\n')
}

async function put(text: string): Promise<void> {
  const ok = await setContent(text)
  if (ok || text.length <= REBUILD_MAX_CHARS || !lowerPageLimit() || reading === null) return
  // The glasses refused a long update: cut the answer into shorter pages.
  pages = paginate(answered[reading].answer, PAGE_INNER_WIDTH)
  pageIndex = 0
  pageWin = null
  updateNote()
  await setContent(pages[0].text)
}

// A new question on the list while the list is showing: the list has no
// in-place update, so the page is rebuilt (and lands on the newest, the top).
function refreshList(): void {
  updateNote()
  if (reading === null) requestRebuild(parakeetTool)
}

async function askNow(mySession: number): Promise<void> {
  if (mySession !== session || asking || lines.length === 0) return
  if (!llm) {
    status('Parakeet: add an AI key in Jarvis on the companion page')
    return
  }
  asking = true
  updateNote()
  const began = Date.now()
  const upTo = lines.length
  const lastAsked = [...lines].reverse().find(l => l.speaker !== 'self')?.text ?? ''
  try {
    const reply = await askModel(
      llm,
      [
        {
          role: 'user',
          text: transcriptFor(
            lines.map(l => ({ ...l, speaker: 'unknown' })),
            handled,
          ),
        },
      ],
      {
        instruction: PARAKEET_INSTRUCTION,
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
      const found = text ? splitQuestion(text, questionLine(lastAsked)) : null
      // A reply that is only a question line has no answer to read, and the
      // same question twice in a row is one question (seen with a small PC
      // model, which does not always respect "Earlier").
      const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
      const last = answered[answered.length - 1]
      if (
        found &&
        !found.answer.startsWith('Q:') &&
        !(last && same(last.question, found.question))
      ) {
        answered.push(found)
      }
    } else if (reply.kind === 'error') {
      status(`Parakeet: failed (${reply.message})`)
    }
  } finally {
    asking = false
    if (mySession === session) refreshList()
  }
}

// When the current wait for quiet began; 0 when none is running.
let waitingSince = 0

function scheduleAsk(mySession: number): void {
  if (askTimer !== null) clearTimeout(askTimer)
  if (waitingSince === 0) waitingSince = Date.now()
  askTimer = setTimeout(() => {
    askTimer = null
    // Still being spoken or written down: wait for the end of it - but not
    // for ever. In a noisy room it is never quiet, and Parakeet sat on
    // "Listening for a question..." through five questions (G2-133).
    const busy = transcribing || waiting.length > 0 || segmenter?.level().speaking
    if (busy && Date.now() - waitingSince < MAX_WAIT_FOR_QUIET_MS) {
      scheduleAsk(mySession)
      return
    }
    waitingSince = 0
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
      showCaptions()
      if (triggersAnswer(line)) scheduleAsk(mySession)
    })
    .catch(e => status(`Parakeet: transcription failed (${e instanceof Error ? e.message : e})`))
    .finally(() => {
      transcribing = false
      transcribeNext(mySession)
    })
}

// Dev-only (companion/devControl.ts): a line as if heard and transcribed,
// so the simulator, which has no conversation to hear, can test the rest.
export function devHear(speaker: string, text: string): void {
  const line = { speaker, text, at: Date.now() }
  lines.push(line)
  showCaptions()
  if (triggersAnswer(line)) scheduleAsk(session)
}

function onSegment(segment: Segment, mySession: number): void {
  if (waiting.length >= MAX_WAITING) waiting.shift()
  waiting.push(segment)
  transcribeNext(mySession)
}

function listen(mySession: number): Promise<(() => void) | null> {
  return openMic((pcm, speaker) => {
    if (mySession !== session || !segmenter) return
    const segment = segmenter.push(pcm, rmsLevel(toFloat32(pcm)), speaker, Date.now())
    if (segment) onSegment(segment, mySession)
  })
}

// The mic on or off. Off drops whatever was half heard: on the answer screen
// that is the wearer reading aloud, which must not become a question.
async function setListening(on: boolean): Promise<void> {
  const mySession = session
  if (!on) {
    releaseMic?.()
    releaseMic = null
    segmenter = null
    waiting = []
    if (askTimer !== null) clearTimeout(askTimer)
    askTimer = null
    waitingSince = 0
    return
  }
  if (releaseMic) return
  segmenter = createSegmenter()
  const release = await listen(mySession)
  if (mySession !== session) {
    release?.()
    return
  }
  if (!release) {
    status('Parakeet: could not start the glasses microphone')
    return
  }
  // Stopped again while the mic was starting.
  if (paused || reading !== null) {
    release()
    return
  }
  releaseMic = release
}

async function start(): Promise<void> {
  stop()
  const mySession = ++session
  lines = []
  handled = 0
  answered = []
  reading = null
  ;[llm, aboutMe, profile] = await Promise.all([getLlmConfig('phone'), getAboutMe(), getProfile()])
  if (mySession !== session) return
  await setListening(true)
  if (releaseMic) status(`Parakeet: listening (Whisper via ${engineDescription()})`)
  updateNote()
}

function stop(): void {
  session++
  void setListening(false)
  transcribing = false
  asking = false
  paused = false
  setStatusNote(null)
}

// Live captions over the list (G2-133): what was heard, newest first, so the
// wearer can see whether the questions are being heard right.
function captions(): string {
  const rows: string[] = []
  for (let i = lines.length - 1; i >= 0 && rows.length < LIST_HEADER_ROWS; i--) {
    rows.push(...wrapLines(lines[i].text, PAGE_INNER_WIDTH))
  }
  return rows.slice(0, LIST_HEADER_ROWS).join('\n') || '(live captions appear here)'
}

function showCaptions(): void {
  if (reading === null) void setListHeader(captions())
}

function listItems(): string[] {
  if (answered.length === 0) {
    return [paused ? 'Paused - hold to listen again' : 'Listening for a question...']
  }
  return answered.map((a, i) => `${i + 1}. ${a.question}`.slice(0, ITEM_MAX_CHARS)).reverse()
}

export const parakeetTool: Tool = {
  name: 'Parakeet',
  confirmOnExit: () => true,
  confirmPrompt: () => 'End Parakeet?',
  contentKind: () => (reading === null ? 'list' : 'text'),
  listItems,
  listHeader: () => (reading === null ? captions() : null),
  // Only reached for the answer screen (the list is a list).
  initialContent: () => rebuildSafe(pageText()),
  onOpen: () => {
    void start()
  },
  // An answer longer than a rebuild carries: put the whole page up.
  onContentReady: () => {
    if (reading === null) return
    const full = pageText()
    if (full !== rebuildSafe(full)) void put(full)
  },
  onClose: stop,
  onListSelect: index => {
    // Newest is on top: the first item is the last question.
    const chosen = answered.length - 1 - index
    if (answered.length === 0 || chosen < 0) return
    reading = chosen
    pages = paginate(answered[chosen].answer, PAGE_INNER_WIDTH)
    pageIndex = 0
    pageWin = null
    void setListening(false)
    updateNote()
  },
  // Double-tap on an answer: back to the list, and listening again. On the
  // list it falls through to the leave prompt.
  onBack: () => {
    if (reading === null) return false
    reading = null
    pages = []
    if (!paused) void setListening(true)
    refreshList()
    return true
  },
  // Long press on the list: pause or resume listening.
  onLongPress: () => {
    if (reading !== null) return
    paused = !paused
    void setListening(!paused)
    status(`Parakeet: ${paused ? 'paused' : 'listening again'}`)
    refreshList()
  },
  // Called only for a swipe at a page's top (-1) or bottom (1) edge.
  onScroll: delta => {
    if (reading === null || pages.length === 0) return
    const next = movePaged(
      pages.map(p => p.text.split(/\n/).length),
      { page: pageIndex, win: pageWin },
      delta,
    )
    if (!next) return
    pageIndex = next.page
    pageWin = next.win
    updateNote()
    void put(pageText())
  },
  onSuspend: () => setStatusNote(null),
  onResume: updateNote,
}
