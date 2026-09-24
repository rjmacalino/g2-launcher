// Design tokens: the small set of numbers a page builder or tool should read
// from here instead of re-deriving or guessing its own. Layout geometry
// (canvas size, content area, container IDs) already has one home,
// platform/page.ts, and stays there rather than being duplicated under a
// second name - this file holds what platform/page.ts does not: brightness
// roles and icon sizing.

// textColor levels (0 to 4, see docs/platform.md's Text containers section)
// named for what they are used for, not their number, so a tool reads
// BRIGHTNESS.secondary rather than re-deciding what "2" means every time.
// Level 0 is documented as possibly invisible - deliberately not given a
// role here, since "disabled" should still be legible, just dim.
export const BRIGHTNESS = {
  primary: 4,
  secondary: 2,
  disabled: 1,
} as const

// Native resolution for an in-app icon (see docs/platform.md, Image
// containers: "24 x 24 is the norm" from the official design guidelines).
// Store icons have a stricter 1-bit, 2x2-block rule that does not apply
// here - this is for icons drawn into a page's own image container, not the
// app's store listing icon.
export const ICON_SIZE = 24
