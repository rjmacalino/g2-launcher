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

// Screens in one page for a style.
export function screensPerPage(style: ReadingStyle): number {
  return style === 'screens' ? 1 : 3
}
