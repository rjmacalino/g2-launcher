// How a long answer reads on the glasses (G2-191), a Setting. The glasses
// cannot be scrolled to a position: new text always opens at its top. So
// going back up is a choice between landing where you left off and keeping
// the native scroll; RJ picks on the phone.
//   pageTop     - pages of three screens; up opens the page above from its
//                 top, scrollable down to where you were.
//   continuity  - pages of three screens; up lands on the last screen above
//                 (right above where you were); each further up steps a
//                 screen back, each scrollable down to the page end.
//   screens     - one screen per page, no scrolling: every swipe turns a
//                 screen, so up shows exactly the screen above.
export type ReadingStyle = 'pageTop' | 'continuity' | 'screens'

export const READING_STYLES: { id: ReadingStyle; label: string }[] = [
  { id: 'pageTop', label: 'Up: page above from its top (scrolls)' },
  { id: 'continuity', label: 'Up: screen just above (continues)' },
  { id: 'screens', label: 'One screen per page (no scrolling)' },
]

export const DEFAULT_READING_STYLE: ReadingStyle = 'pageTop'

export function parseReadingStyle(saved: string): ReadingStyle {
  return READING_STYLES.some(s => s.id === saved) ? (saved as ReadingStyle) : DEFAULT_READING_STYLE
}

// Where long code is read (G2-193): in the text with the rest, or only in the
// code view (pictures with line numbers, never cut mid-line), with one line
// "[code: 34 lines - tap: code]" in the text instead.
export type LongCode = 'inline' | 'codeView'

export const LONG_CODE_CHOICES: { id: LongCode; label: string }[] = [
  { id: 'inline', label: 'In the answer text' },
  { id: 'codeView', label: 'Only in the code view (one line in the text)' },
]

export function parseLongCode(saved: string): LongCode {
  return saved === 'codeView' ? 'codeView' : 'inline'
}

// How fast answers appear (G2-197). The typing speeds reveal the answer at a
// reading pace, following its newest line; instant shows it from its first
// line as it arrives and never moves down by itself.
export type AnswerSpeed = 'slow' | 'normal' | 'fast' | 'instant'

export const ANSWER_SPEEDS: { id: AnswerSpeed; label: string }[] = [
  { id: 'slow', label: 'Type slowly' },
  { id: 'normal', label: 'Type at a reading pace' },
  { id: 'fast', label: 'Type fast' },
  { id: 'instant', label: 'Instant, stay at the top' },
]

export function parseAnswerSpeed(saved: string): AnswerSpeed {
  return ANSWER_SPEEDS.some(s => s.id === saved) ? (saved as AnswerSpeed) : 'normal'
}

// Characters a second; instant shows everything at once.
export function charsPerSecond(speed: AnswerSpeed): number {
  if (speed === 'slow') return 18
  if (speed === 'fast') return 60
  if (speed === 'instant') return Infinity
  return 30
}

// Screens in one page for a style.
export function screensPerPage(style: ReadingStyle): number {
  return style === 'screens' ? 1 : 3
}
