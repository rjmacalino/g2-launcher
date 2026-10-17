import { transcriptForCue, type CueLine } from './cues'

// What Wingman keeps when a conversation ends (G2-67): a short written
// record from Gemini, saved as a Jarvis conversation with the transcript
// behind it, so Jarvis can be asked about it later (its digest carries it
// into every new question - see features/chat/digest.ts). Pure; the save
// itself goes through core/assistantContext.ts.

export const SUMMARY_INSTRUCTION =
  'You write a short record of a conversation the wearer of smart glasses ' +
  'just had, from a rough automatic transcript - "You:" is the wearer, ' +
  '"Them:" the other person, unlabelled lines could be either, and expect ' +
  'transcription mistakes. In at most 120 words of plain text: who it ' +
  'seemed to be with and what it was about, the key points, anything either ' +
  'person promised or asked the other to do, and anything the wearer should ' +
  'remember. Short sentences, no headings, no markdown, no bullet ' +
  'characters. If the transcript is too garbled to tell, say so in one ' +
  'sentence.'

export const SUMMARY_MAX_TOKENS = 300

// Jarvis's saved chats share one size budget (features/chat/store.ts), so
// a long conversation keeps only its last part; the summary carries the
// rest.
const STORED_TRANSCRIPT_CHARS = 2500

export function summaryRequest(lines: readonly CueLine[]): string {
  return transcriptForCue(lines).replace(
    'Conversation so far (newest last):',
    'Transcript of the conversation:',
  )
}

export function storedTranscript(lines: readonly CueLine[]): string {
  const label = (s: string) => (s === 'self' ? 'You: ' : s === 'other' ? 'Them: ' : '')
  const full = lines.map(l => `${label(l.speaker)}${l.text}`).join('\n')
  return full.length > STORED_TRANSCRIPT_CHARS
    ? `...${full.slice(full.length - STORED_TRANSCRIPT_CHARS)}`
    : full
}

// The title in Jarvis's list: the summary's first sentence, or the time
// when there is no summary.
export function summaryTitle(summary: string | null, startedAt: number): string {
  const first = summary?.split(/(?<=[.!?])\s/)[0]?.trim()
  if (first) return `Wingman: ${first}`
  const time = new Date(startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `Wingman conversation at ${time}`
}

// A saved conversation that came from Wingman - including ones saved
// before it was renamed from Jarvis Live (titled "Live: ...").
export function isWingmanTitle(title: string): boolean {
  return /^(Wingman|Live)( conversation at|:)/.test(title)
}
