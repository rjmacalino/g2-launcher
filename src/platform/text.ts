// Pixel-accurate text measurement, re-exported from Even Realities' own
// library rather than hand-measured screenshots. It mirrors the LVGL
// rendering the firmware actually does (advance widths, kerning, per-glyph
// rounding on wrap), which is the thing our own estimates were only ever
// approximating - see docs/platform.md, "Text containers".
export { getAdvW, getTextWidth, measureTextWrap, pxTruncate } from '@evenrealities/pretext'

// The one fixed metric pretext does not expose directly: list rows are a
// constant 40px tall, independent of content, unlike text lines (27px,
// ROW_HEIGHT_PX in page.ts). Documented by Even Realities' font-measurement
// skill; see docs/platform.md, "List containers".
export const LIST_ITEM_HEIGHT_PX = 40
