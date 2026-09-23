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

// The modal sits in its own container so the content container is never touched
// while a prompt is open. That is the whole design: every content change resets
// the firmware's scroll, so a modal that writes into the content container costs
// the wearer their place in whatever they were reading.
//
// It needs no off switch. Text containers have no background fill, so an empty
// one draws nothing at all. This was not true of the image container we tried
// first, which could be drawn but never cleared.
export const CONTAINER_ID_MODAL = 5
export const CONTAINER_NAME_MODAL = 'modal'

// Covers the whole content area, but never the status bar. The clock stays
// readable with a prompt open, which is the difference between a dialog inside
// the app and one that takes over the glasses.
//
// Full area for a practical reason as well as a visual one. The content
// container keeps input capture while the prompt is open, because capture is
// fixed at page creation and moving it means a rebuild, which costs the scroll
// position. So a scroll aimed at the marker also scrolls the tool behind. At full
// area that movement is hidden rather than distracting.
export const MODAL_WIDTH = CANVAS_WIDTH
export const MODAL_HEIGHT = CONTENT_HEIGHT
export const MODAL_X = 0
export const MODAL_Y = CONTENT_Y

// zOrderIndex is all or nothing per page: once any container sets it, every
// container must set a unique one. Larger renders in front, so the modal sits
// above the content it is drawn over.
export const Z_STATUS_LEFT = 1
export const Z_STATUS_CENTRE = 2
export const Z_STATUS_RIGHT = 3
export const Z_CONTENT = 4
export const Z_MODAL = 5

// Brightness levels, 0 to 4. Text drawn at 0 is dimmed rather than hidden, which
// is what gives the faded backdrop behind an open modal.
export const BRIGHTNESS_NORMAL = 4
export const BRIGHTNESS_DIMMED = 0

// Replace the text in the content area, in place, with no page rebuild.
//
// Tools call this rather than building their own TextContainerUpgrade, so no tool
// needs to know a container ID. A tool that guessed one wrong would write over the
// status bar, and the whole reason the IDs are fixed is that nothing should be
// relying on getting that right.
// Change the content area's brightness WITHOUT touching its text.
//
// The omitted `content` field is the point, not an oversight. Every upgrade that
// carries content resets the firmware's scroll position to the top. A
// brightness-only upgrade does not, which was verified on hardware rather than
// assumed: dimming a scrolled teleprompter and brightening it again left the
// wearer exactly where they were reading.
//
// That is what makes a modal possible at all. Dim the tool, draw the prompt over
// it, restore brightness afterwards, and the tool never knew anything happened.
export function setContentBrightness(level: number): Promise<boolean> {
  return bridge
    .textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: CONTAINER_ID_CONTENT,
        containerName: CONTAINER_NAME_CONTENT,
        textColor: level,
      }),
    )
    .then(ok => {
      if (!ok) status('Brightness change failed')
      return ok
    })
}

// Draw the modal, or clear it by passing an empty string.
export function setModalText(text: string): Promise<boolean> {
  return bridge
    .textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: CONTAINER_ID_MODAL,
        containerName: CONTAINER_NAME_MODAL,
        content: text,
      }),
    )
    .then(ok => {
      if (!ok) status('Modal update failed')
      return ok
    })
}

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
