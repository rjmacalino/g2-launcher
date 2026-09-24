// Candidate glyphs for the "Glyph sheet" probe. Everything here is listed as
// available in docs/platform.md's Glyphs section (sourced from the official
// design guidelines and the even-g2-notes community reference) but none of
// it has been checked against THIS app's own hardware - the weather icon
// trial (see features/weather's history) already proved that "documented as
// available" and "actually renders here" are not the same claim; that one
// turned out to render as nothing at all, not even a placeholder box.
//
// \uXXXX escapes throughout: this file stays ASCII on disk, same convention
// as the rest of the repo, while still emitting the real codepoint at
// runtime.
export const GLYPH_CANDIDATES: readonly { label: string; char: string }[] = [
  { label: 'U+2500 thin line', char: '\u2500' },
  { label: 'U+2501 thick line', char: '\u2501' },
  { label: 'U+2502 vertical line', char: '\u2502' },
  { label: 'U+256D rounded corner', char: '\u256d' },
  { label: 'U+256E rounded corner', char: '\u256e' },
  { label: 'U+256F rounded corner', char: '\u256f' },
  { label: 'U+2570 rounded corner', char: '\u2570' },
  { label: 'U+2581 lower 1/8 block', char: '\u2581' },
  { label: 'U+2588 full block', char: '\u2588' },
  { label: 'U+2589 left 7/8 block', char: '\u2589' },
  { label: 'U+258f left 1/8 block', char: '\u258f' },
  { label: 'U+2592 medium shade', char: '\u2592' },
  { label: 'U+25a0 filled square', char: '\u25a0' },
  { label: 'U+25a1 empty square', char: '\u25a1' },
  { label: 'U+25cf filled circle', char: '\u25cf' },
  { label: 'U+25cb empty circle', char: '\u25cb' },
  { label: 'U+25b2 filled triangle up', char: '\u25b2' },
  { label: 'U+25b6 filled triangle right', char: '\u25b6' },
  { label: 'U+25bc filled triangle down', char: '\u25bc' },
  { label: 'U+25c0 filled triangle left', char: '\u25c0' },
  { label: 'U+25ce bullseye', char: '\u25ce' },
  { label: 'U+2605 filled star', char: '\u2605' },
  { label: 'U+2606 empty star', char: '\u2606' },
  { label: 'U+00b0 degree sign', char: '\u00b0' },
  { label: 'U+2190 arrow left', char: '\u2190' },
  { label: 'U+2191 arrow up', char: '\u2191' },
  { label: 'U+2192 arrow right', char: '\u2192' },
  { label: 'U+2193 arrow down', char: '\u2193' },
  // Included as a deliberate known-bad control, not a hopeful guess: this
  // exact codepoint already failed on our hardware (see
  // features/weather/conditions.ts's history). If the sheet does not flag
  // this one as missing, the sheet itself is not trustworthy.
  { label: 'U+2600 sun (expected to fail)', char: '\u2600' },
]
