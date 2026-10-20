// Where the wearer is in something they page through (G2-102), as it is
// shown in the middle of the status bar: "2/3 [--|-----]". Plain ASCII, so
// the firmware font cannot drop a glyph. null when there is only one
// place, so nothing is shown. Pure, tested in tests/position.test.ts.
const CELLS = 8

export function positionLabel(index: number, count: number): string | null {
  if (count <= 1) return null
  const i = Math.min(Math.max(index, 0), count - 1)
  const at = Math.round((i * (CELLS - 1)) / (count - 1))
  const bar = Array.from({ length: CELLS }, (_, cell) => (cell === at ? '|' : '-')).join('')
  return `${i + 1}/${count} [${bar}]`
}
