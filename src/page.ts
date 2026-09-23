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

// LEAVE-CONFIRM PROMPT: A RECORD OF WHAT DOES NOT WORK, kept because five
// attempts failed here and the sixth should not repeat any of them blind.
//
// An image container occludes reliably (every pixel value paints, none are
// transparent) but cannot be cleared: a zero-length push returns sendFailed, and
// the container must be declared at page creation, so a drawn image backdrop is
// permanently visible.
//
// A second TEXT container layered over content with zOrderIndex does NOT
// occlude. Text containers have no background fill, so zOrderIndex controls
// draw order only. Two text containers sharing the same rows render both sets
// of glyphs interleaved rather than one hiding the other, confirmed on hardware
// as garbled overlapping text.
//
// A native ListContainerProperty gives correct bounce behaviour, since firmware
// owns real scroll and highlight state for a list. But a list can only be shown
// or changed by REBUILDING the page, and rebuilding was confirmed on hardware to
// reset the teleprompter's scroll position even when content's own text is left
// untouched. Costs position every time, whatever its bounce behaviour.
//
// A permanent reserved strip at the bottom of every tool page avoided the
// rebuild (in-place upgrades only, position genuinely safe), but shrank the
// teleprompter's normal reading height by half, ALL THE TIME, not only while a
// prompt was open. That is a real, constant cost to the primary use of the app,
// paid for an occasional dialog. Reported directly as "you broke the display,"
// correctly: reserving space nobody is using yet is not free, it is a visible,
// permanent hole in the one thing this app is for.
//
// Worse, with content still holding capture (moving capture needs a rebuild,
// which is the thing being avoided), the still-overflowing script kept
// scrolling under a scroll gesture aimed at the marker, and its large, moving
// text drew attention away from a marker change in a small strip below it. Same
// confusion as the interleaved-glyph failure, different mechanism: two things
// changing on screen at once, one dominant, one easy to miss.
//
// CONCLUSION: on this platform, a scroll-selectable dialog that neither costs
// permanent display space nor risks the teleprompter's position does not exist.
// Every container is fixed in size for its lifetime; only content and
// brightness can change without a rebuild; occlusion only exists via images,
// which cannot be un-drawn. Given that, the confirm prompt goes back to
// replacing content's own text temporarily (setContent below), the design from
// the second attempt above, with the position loss on cancel accepted as the
// least bad of the failures actually available.

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
