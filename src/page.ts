import { TextContainerUpgrade } from '@evenrealities/even_hub_sdk'
import { bridge, status } from './bridge'

// Page geometry, and the one way to change what the content area says.
//
// Every page is the same two containers: a status bar across the top and one
// content container filling the rest. The menu's content is a list, a tool's
// content is text, but the geometry and the IDs never change.
//
// The IDs being invariant is the point, not a convenience. We still do not know
// whether textContainerUpgrade matches on containerID alone or on ID and name
// together (#14). If it is ID alone, a clock tick aimed at the bar could land on
// tool content. Giving the bar ID 1 on every page and content ID 2 on every page
// makes that impossible either way, so the open question stops mattering here
// instead of being something to be careful about.
export const CANVAS_WIDTH = 576
export const CANVAS_HEIGHT = 288
export const PADDING = 4

export const STATUS_BAR_HEIGHT = 32

// Breathing room between the bar and the content below it. Without this the first
// line of a tool sits directly under the clock and the two read as one block,
// which makes the bar harder to ignore when you are trying to read the tool and
// harder to find when you are not.
export const CONTENT_GAP = 8

export const CONTENT_Y = STATUS_BAR_HEIGHT + CONTENT_GAP
export const CONTENT_HEIGHT = CANVAS_HEIGHT - CONTENT_Y

// A list item's native selection border draws a rounded rectangle at the item's
// own bounds. When itemWidth runs flush to the canvas edge (right edge at
// x = CANVAS_WIDTH, same as the canvas itself), the border's right side has
// nowhere left to render and gets clipped, while the left side, sitting a full
// border-width inside x = 0, renders cleanly. Confirmed visually: the menu list's
// highlight box was a clean rounded rect on the left and cut off flat on the
// right.
//
// Inset by PADDING on the side that was clipping, so the box sits fully inside
// canvas bounds and the border renders symmetrically, matching the left side
// rather than the left side being the accidental exception.
export const LIST_ITEM_WIDTH = CANVAS_WIDTH - PADDING

// Measured rather than estimated: on the simulator consecutive rendered lines sat
// exactly 27px apart, and a blank line cost exactly 54. The firmware owns text
// metrics and does not report them, so this is the one number here that came from
// looking at a screenshot rather than from the docs.
export const ROW_HEIGHT_PX = 27

// How many rows of text fit in the content area. Used for vertical centring,
// which is the only kind of centring available: text containers are top-left
// aligned with no alignment option, and a non-monospaced font makes horizontal
// centring by space padding unreliable. Real horizontal centring needs a
// container positioned for it.
export const CONTENT_ROWS = Math.floor((CONTENT_HEIGHT - PADDING * 2) / ROW_HEIGHT_PX)

// The bar occupies IDs 1 to 3, one per slot. Content is 4 on every page.
//
// What matters is that bar IDs and the content ID are disjoint and identical on
// every page, so a bar update can never land on content whichever way the firmware
// matches. Adding slots means extending this range, never reusing the content ID.
export const CONTAINER_ID_STATUS_LEFT = 1
export const CONTAINER_ID_STATUS_CENTRE = 2
export const CONTAINER_ID_STATUS_RIGHT = 3
export const CONTAINER_ID_CONTENT = 4
export const CONTAINER_NAME_CONTENT = 'tool'

// The leave-confirm prompt is a native list, not hand-drawn text. See the note
// below for why. It occupies the SAME content slot (rebuilding replaces whatever
// is at CONTAINER_ID_CONTENT), plus a small title strip above it at a distinct ID.
// Title and list sit at different y-ranges, so unlike the dead-end below there is
// nothing here for two containers to fight over.
export const CONTAINER_ID_CONFIRM_TITLE = 5
export const CONTAINER_NAME_CONFIRM_TITLE = 'confirm.title'

export const CONFIRM_TITLE_HEIGHT = STATUS_BAR_HEIGHT
export const CONFIRM_LIST_Y = CONTENT_Y + CONFIRM_TITLE_HEIGHT
export const CONFIRM_LIST_HEIGHT = CONTENT_HEIGHT - CONFIRM_TITLE_HEIGHT

// GEOMETRY-LEVEL DEAD ENDS, kept as notes rather than deleted quietly.
//
// A second container layered over content (a "modal") was tried twice and both
// routes failed for platform reasons rather than implementation bugs.
//
// An image container occludes reliably (every pixel value paints, none are
// transparent) but cannot be cleared: a zero-length push returns sendFailed, and
// the container must be declared at page creation, so a drawn image backdrop is
// permanently visible.
//
// A second text container layered with zOrderIndex does NOT occlude. Text
// containers have no background fill, so zOrderIndex controls draw order only.
// Two text containers sharing the same rows render both sets of glyphs
// interleaved rather than one hiding the other, confirmed on hardware as garbled
// overlapping text.
//
// A THIRD attempt replaced the content container's own text with hand-drawn
// prompt lines and a "<" marker, re-sent on every scroll tick. That avoided the
// overlap, but it bounced on every single move rather than only at the genuine
// ends of the No/Yes choice. The reason: a container that is re-pushed small and
// non-overflowing on every tick never gives the firmware anything to scroll, so
// every gesture looks identical to the firmware regardless of direction or
// position, and it plays the boundary animation every time. Getting a bounce
// only at real edges needs the firmware to own genuine scroll state, which a
// repush-per-tick design cannot provide.
//
// The fix is CONFIRM_LIST below: a native ListContainerProperty, exactly the
// widget the launcher menu already uses. Firmware owns highlight, scroll, and
// boundary bounce, and reports the chosen index back on click. No hand-rolled
// marker, no re-push per tick, correct bounce behaviour for free.

// Replace the text in the content area, in place, with no page rebuild.
//
// Tools call this rather than building their own TextContainerUpgrade, so no tool
// needs to know a container ID. A tool that guessed one wrong would write over the
// status bar, and the whole reason the IDs are fixed is that nothing should be
// relying on getting that right.
export function setContent(text: string): Promise<boolean> {
  return bridge
    .textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: CONTAINER_ID_CONTENT,
        containerName: CONTAINER_NAME_CONTENT,
        content: text,
      }),
    )
    .then(ok => {
      if (!ok) status('Content update failed')
      return ok
    })
}
