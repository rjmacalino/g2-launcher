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

// The leave prompt is a title (this question, non-interactive) above a list
// (the two answers). A list item's own text cannot carry a non-selectable
// header row - every item in a list is uniformly tappable - so the question
// needs its own small text container, separate from the two real choices.
export const CONTAINER_ID_CONFIRM_TITLE = 5
export const CONTAINER_NAME_CONFIRM_TITLE = 'confirm.title'

// Sized to the measured single-row height (ROW_HEIGHT_PX), not
// STATUS_BAR_HEIGHT, which is 5px taller because it was sized for the status
// bar's own purpose, not for holding exactly one tight line of text here.
export const CONFIRM_TITLE_HEIGHT = ROW_HEIGHT_PX
export const CONFIRM_LIST_Y = CONTENT_Y + CONFIRM_TITLE_HEIGHT

// UNVERIFIED HYPOTHESIS, recorded because the previous attempt at this gap
// was wrong and should not be repeated blind.
//
// Shrinking the title box did not close the gap seen on hardware: a large
// visible space remained between the question and "No" even though the title
// and list boxes are positioned flush, zero pixels apart. That rules out
// container positioning as the cause.
//
// The working theory is that list items render vertically CENTRED within
// their container, not top-aligned like text. CONFIRM_LIST_HEIGHT was
// previously CONTENT_HEIGHT - CONFIRM_TITLE_HEIGHT, about 220px, to hold just
// two items - if they centre in that much space, most of it is blank space
// above them, which is exactly the symptom reported. The launcher menu likely
// shows the same centring but with 4 items in a similarly sized box, leaving
// comparatively little empty space per item, which would be why it never
// looked wrong there.
//
// ITEM_HEIGHT_ESTIMATE is a guess, not a measurement: double the text row
// height, on the reasoning that a list row needs to be a bigger touch target
// than a line of text, and nothing more precise than that. Sized for exactly
// CONFIRM_ITEM_COUNT items rather than the leftover content area, so there is
// little box left for centring to hide space inside.
//
// If this does not close the gap, the theory is wrong and needs abandoning
// rather than iterating on the same guess; the way to actually pin this down
// is the numbered-items calibration this project has used before (render a
// list of distinct known items, observe on hardware, measure directly)
// rather than guessing a second time.
const ITEM_HEIGHT_ESTIMATE = ROW_HEIGHT_PX * 2
const CONFIRM_ITEM_COUNT = 2
export const CONFIRM_LIST_HEIGHT = ITEM_HEIGHT_ESTIMATE * CONFIRM_ITEM_COUNT

// LEAVE-CONFIRM PROMPT: A RECORD OF WHAT DID NOT WORK, AND WHY THE SIXTH
// ATTEMPT WAS WRONG TO REJECT THE FIFTH'S APPROACH.
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
// A permanent reserved strip at the bottom of every tool page avoided a rebuild
// (in-place upgrades only), but shrank the teleprompter's normal reading height
// by half, ALL THE TIME, not only while a prompt was open. Reported directly as
// "you broke the display": reserving space nobody is using yet is not free, it
// is a visible, permanent hole in the one thing this app is for. It also kept
// content holding capture, so a scroll aimed at the marker also scrolled the
// still-overflowing script underneath, and its large movement drew attention
// away from the marker. Reverted.
//
// A NATIVE ListContainerProperty was tried and reverted too early. The stated
// reason at the time was that rebuilding to show a list resets the
// teleprompter's scroll position, which is true, but the conclusion drawn from
// it was wrong: a plain text swap via textContainerUpgrade ALSO resets scroll,
// because any content-carrying update does, not only a full rebuild. Entering
// the confirm prompt has never been free, in any version. The native list was
// rejected for a cost that the text-swap version replacing it was already
// paying, just less visibly, and the trade actually made was "keep the
// hand-rolled bounce bug" in exchange for a cost that was not actually avoided.
//
// So the confirm prompt is a native list again (see confirmContainers in
// main.ts): correct bounce at the real ends of No/Yes, for no additional cost
// versus the text version it replaced.
//
// This also unlocked the actual fix for where "Yes" goes. Teleprompter now has
// two levels of its own depth (script picker, then reading), and confirming
// leave should step back one level, not necessarily out of the tool entirely -
// the same "back" that double-tap already means everywhere else in this app.
// See Tool.onConfirmedExit in tools/types.ts.

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
