// Where the wearer is in something they page through (G2-102), as it is
// shown in the middle of the status bar: "Page 2 of 3". null when there is
// only one place, so nothing is shown. Pure, tested in tests/position.test.ts.
export function positionLabel(index: number, count: number): string | null {
  if (count <= 1) return null
  const i = Math.min(Math.max(index, 0), count - 1)
  return `Page ${i + 1} of ${count}`
}

// Which screens of an answer are showing (G2-112), from the rows on show: a
// window the firmware scrolls smoothly can span several screens, so the
// label is a range - "Page 4 of 5", or "Pages 2-4 of 5". null when the whole
// answer fits one screen.
export function screenRange(
  startRow: number,
  endRow: number,
  totalRows: number,
  rowsPerScreen: number,
): string | null {
  const screens = Math.ceil(totalRows / rowsPerScreen)
  if (screens <= 1) return null
  const first = Math.min(screens, Math.floor(Math.max(0, startRow) / rowsPerScreen) + 1)
  const last = Math.min(screens, Math.max(first, Math.ceil(endRow / rowsPerScreen)))
  return first === last ? `Page ${first} of ${screens}` : `Pages ${first}-${last} of ${screens}`
}
