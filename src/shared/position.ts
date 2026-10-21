// Where the wearer is in something they page through (G2-102), as it is
// shown in the middle of the status bar: "Page 2 of 3". null when there is
// only one place, so nothing is shown. Pure, tested in tests/position.test.ts.
export function positionLabel(index: number, count: number): string | null {
  if (count <= 1) return null
  const i = Math.min(Math.max(index, 0), count - 1)
  return `Page ${i + 1} of ${count}`
}
