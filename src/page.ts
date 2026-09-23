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

// A confirm strip reserved permanently at the bottom of every TOOL page (never
// the menu, which exits straight through the OS dialog and never asks). It is
// declared once at tool-open time alongside the content container and simply
// stays empty until needed, because it must never be added by a later rebuild:
// see CONTAINER_ID_CONFIRM below for why a rebuild cannot be used here at all.
//
// Four rows: "End ToolName", a blank line, "No", "Yes".
export const CONFIRM_STRIP_ROWS = 4
export const CONFIRM_STRIP_GAP = 8
export const CONFIRM_STRIP_HEIGHT = CONFIRM_STRIP_ROWS * ROW_HEIGHT_PX + PADDING * 2

// Tool content is shorter than the menu's full content area by the strip and its
// gap, permanently, whether or not a prompt is showing. The teleprompter does not
// care: since G2-17 it hands the whole script to the firmware and lets it scroll
// natively within whatever height it is given, so a few fewer visible rows costs
// nothing structurally, just a slightly smaller window.
export const TOOL_CONTENT_HEIGHT = CONTENT_HEIGHT - CONFIRM_STRIP_GAP - CONFIRM_STRIP_HEIGHT
export const CONFIRM_STRIP_Y = CONTENT_Y + TOOL_CONTENT_HEIGHT + CONFIRM_STRIP_GAP

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

export const CONTAINER_ID_CONFIRM = 5
export const CONTAINER_NAME_CONFIRM = 'confirm'

// GEOMETRY-LEVEL DEAD ENDS, kept as notes rather than deleted quietly. Four
// attempts at the leave-confirm prompt failed before this one, each for a
// platform reason rather than an implementation bug, and each finding narrowed
// what was left to try.
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
// Replacing content's own text with hand-drawn prompt lines and a "<" marker,
// re-sent on every scroll tick, avoided the overlap but bounced on every single
// move rather than only at the genuine ends of No/Yes: a container re-pushed
// small and non-overflowing on every tick never gives the firmware anything to
// scroll, so every gesture looks identical to it regardless of direction.
//
// A native ListContainerProperty fixed the bounce, since firmware owns real
// scroll and highlight state for a list. But a list can only be shown or
// changed by REBUILDING the page, and rebuilding the page was confirmed on
// hardware to reset the teleprompter's scroll position even when the content
// container's own text is left untouched. So a list-based prompt, however
// correct its bounce behaviour, costs the wearer their place every time.
//
// That is the constraint this design finally respects: nothing about showing
// or hiding this prompt may ever call rebuildPageContainer. Only
// textContainerUpgrade, only on containers other than content itself.
// CONFIRM_STRIP_* above reserves a permanent, separate region so the prompt
// never needs adding after the fact. It is hand-drawn text again, so the bounce
// problem returns while moving the marker inside this small strip; that is
// accepted, because position loss is the worse failure and no other option on
// this platform avoids both at once.

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

// Write the confirm strip. Never the content container. This is the whole point:
// the strip is a separate container declared once at tool-open, so showing or
// clearing the prompt never touches content's text and never triggers a rebuild,
// which is the only way anything here can coexist with a scrolled teleprompter.
export function setConfirmStrip(text: string): Promise<boolean> {
  return bridge
    .textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: CONTAINER_ID_CONFIRM,
        containerName: CONTAINER_NAME_CONFIRM,
        content: text,
      }),
    )
    .then(ok => {
      if (!ok) status('Confirm strip update failed')
      return ok
    })
}
