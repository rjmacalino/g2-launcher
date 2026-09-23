import { CONTENT_HEIGHT, PADDING, setContent } from '../page'
import {
  STORAGE_KEY_TELEPROMPTER,
  readWithTimeout,
  writeKey,
} from '../storage'
import { bridge, status } from '../bridge'
import type { Tool } from './types'

// Hardcoded per the G2-3 out-of-scope list ("Loading the script from anywhere").
//
// The last stanza describes the shipped gesture model. It has to stay in sync
// with the event handler; it is the only place the wearer is told how to leave
// this page.
const SCRIPT = [
  'Good morning everyone.',
  '',
  'Thank you for being here.',
  'This is the teleprompter.',
  '',
  'Scroll to advance.',
  'Scroll back to return.',
  '',
  'The text you are reading',
  'is delivered in place,',
  'not redrawn.',
  '',
  'That matters because',
  'a full redraw flickers,',
  'and a teleprompter',
  'that flickers is useless.',
  '',
  'Every line here',
  'arrives through a single',
  'in-place update.',
  '',
  'No page rebuild,',
  'no visible flash,',
  'just the words moving.',
  '',
  'When you reach the end,',
  'scrolling further',
  'does nothing.',
  '',
  'When you return to the top,',
  'scrolling further',
  'does nothing too.',
  '',
  'Double tap to return',
  'to the launcher menu.',
  '',
  'On the menu, double tap',
  'to exit the app.',
  '',
  'That is the whole demo.',
  'Thank you.',
]

// How many script lines fit on one screen.
//
// PROVENANCE, because this number looks more rigorous than it is.
//
// The original was `LINES_PER_VIEW = 6`, introduced in G2-3 with the note
// "roughly enough for six comfortable lines; adjust after looking at the
// simulator". Nobody ever adjusted it. APPROX_LINE_HEIGHT_PX below was then
// back-solved from that 6: (288 - 8) / 6 = 46.7, rounded up to 48 because
// rounding up yields fewer lines, and a clipped line is the worse failure.
//
// So this constant is an unverified estimate with arithmetic wrapped around it.
// The formula is not evidence. It is calibration from a guess, and the division
// lends it a precision nothing has earned.
//
// NOW MEASURED, from a simulator screenshot rather than from arithmetic.
//
// Two consecutive rendered lines sat about 27px apart on a canvas rendering at
// roughly 1:1. So the real row height is near 27, and the old 48 was close to
// double it. That is why the teleprompter was showing 5 lines and leaving the
// bottom half of the display empty.
//
// It also matches the documented figure that a full 576x288 text container holds
// roughly 400 to 500 characters, which only works out at around 28px rows.
//
// Set to 28 rather than 27 deliberately: rounding up yields one fewer line, and a
// clipped last line is worse than a slightly short one in a tool whose entire job
// is being readable. If a 9th line turns out to fit cleanly, 27 is the better
// value and this comment is the record of why it was not chosen first.
//
// The derivation from CONTENT_HEIGHT is kept rather than hardcoding the count, so
// that changing STATUS_BAR_HEIGHT cannot silently leave the line count stale.
//
// Separately, and still true: this assumes one script line occupies one display
// row. A line long enough to wrap costs two rows, and the view then shows fewer
// entries than this number claims. Note the script's blank lines each consume a
// row too, which is why the screenshot showed only three lines of actual text out
// of five slots. See #23 and #25.
const APPROX_LINE_HEIGHT_PX = 28
const LINES_PER_VIEW = Math.max(
  1,
  Math.floor((CONTENT_HEIGHT - PADDING * 2) / APPROX_LINE_HEIGHT_PX),
)

// Highest valid starting line. If the script is shorter than one view, this
// clamps to 0 so scrolling never advances past the only page.
const MAX_START = Math.max(0, SCRIPT.length - LINES_PER_VIEW)

// Current starting line. Assigned from storage at startup; updated on every
// successful scroll. Not reset on open; the whole point of G2-7 is that
// reopening resumes where the wearer left off.
let line = 0

function slice(startLine: number): string {
  return SCRIPT.slice(startLine, startLine + LINES_PER_VIEW).join('\n')
}

// Read the persisted line number and clamp it to the current script.
//
// Any failure resolves to 0: starting at the top is the safe default, and every
// plausible representation of "no stored value" (empty string, the literal
// 'null', 'undefined') parses to NaN, which the finite check catches. We do not
// need to know which one the host returns.
async function readStoredLine(): Promise<number> {
  try {
    const raw = await bridge.getLocalStorage(STORAGE_KEY_TELEPROMPTER)
    const parsed = parseInt(raw, 10)
    if (!Number.isFinite(parsed) || parsed < 0) return 0
    return Math.min(parsed, MAX_START)
  } catch {
    return 0
  }
}

// Move the viewport by one line and redraw in place.
//
// Bounds-checked before any state change, and `line` is only committed when the
// upgrade resolves true, so a failure leaves the line number matching what is on
// screen rather than one ahead.
//
// The write to storage is fired after the in-memory commit and does not block
// further input. Fast scrolling may queue writes that race at the host. This
// assumes the SDK delivers messages in order, so the last write wins. That is an
// assumption, not something verified, and the project has been burned before by
// treating a plausible guarantee as a known one.
function scroll(delta: 1 | -1) {
  const target = line + delta
  if (target < 0 || target > MAX_START) return
  setContent(slice(target)).then(ok => {
    if (ok) {
      line = target
      writeKey(STORAGE_KEY_TELEPROMPTER, String(target), 'Failed to persist position')
    } else {
      status('Scroll failed')
    }
  })
}

export const teleprompter: Tool = {
  name: 'Teleprompter',
  initialContent: () => slice(line),
  hydrate: async () => {
    line = await readWithTimeout(readStoredLine(), 0)
  },
  onScroll: scroll,
}
