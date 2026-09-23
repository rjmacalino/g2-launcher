import type { Tool } from './types'

// Hardcoded per the G2-3 out-of-scope list ("Loading the script from anywhere").
//
// The last stanza describes the shipped gesture model. It has to stay in sync
// with the event handler; it is the only place the wearer is told how to leave
// this page.
//
// Line breaks here are deliberate and are not wasted width. A teleprompter script
// is broken where the speaker should breathe, so controlling where lines end is
// the point rather than a limitation. That is worth remembering against #23,
// which proposes letting the firmware wrap prose to fill the full width: right
// for a document, wrong for something being read aloud.
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

// The whole script goes into the container at once, and the firmware scrolls it.
//
// This replaces a paging implementation that maintained a line index, sliced the
// script, persisted the position, and estimated how many lines fit on screen.
// All of that is gone. The reason it existed was that we were scrolling the
// document ourselves; we were also fighting the firmware to do it.
//
// From the display docs: "If content overflows and the container has
// isEventCapture: 1, the firmware scrolls it." The content container has capture,
// because every page needs exactly one and it is the only candidate. But the old
// implementation filled it with exactly the lines that fit, so it never
// overflowed, the firmware found nothing to scroll, and it played its
// end-of-content animation on every single gesture. That was the bounce: the
// firmware telling the truth about a container that fits, while the wearer asked
// a question about a document that does not.
//
// Overflowing the container on purpose hands scrolling back to the firmware,
// which is smooth, needs no line-height estimate, and only signals an end at a
// real one.
//
// WHAT THIS COST: the firmware does not report scroll position. Probed directly
// rather than assumed, and the raw host payload for a scroll is exactly
// {"containerID":4,"containerName":"tool","eventType":2}. No offset, nothing the
// SDK was hiding. So we cannot know where the wearer scrolled to, and the
// persisted position from G2-7 is gone. Reopening starts at the top.
//
// That trade got cheaper than it looked, because the exit confirmation now guards
// the common way a position was lost. What remains is the OS reclaiming the app,
// which is rarer and usually means starting over anyway.
//
// LIMITS: 1000 characters at page creation, 2000 on an in-place update. This
// script is 633. A user-supplied script will not reliably fit, so whichever
// ticket makes the script loadable has to solve windowing, probably with
// contentOffset, which G2-3 established does window into content.
export const teleprompter: Tool = {
  name: 'Teleprompter',
  // Losing your place mid-speech to a mistimed double tap is the failure this
  // guards, and it matters more now that position is not saved: leaving means
  // scrolling back by hand rather than reopening where you were.
  confirmOnExit: true,
  initialContent: () => SCRIPT.join('\n'),
}
