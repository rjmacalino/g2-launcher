// Laying code out for the glasses' code view (G2-73, G2-118): code is drawn
// as an image (ui/codeRender.ts) in the same plain sans-serif as the footer
// line, a proportional font, so widths are measured in pixels (measure is
// given in, which keeps this pure and testable) and indentation is counted
// in columns - one column is the width of a digit - so blocks and their
// guides line up whatever the letters are. Unit-tested in
// tests/code-layout.test.ts.

// One row of the picture: its text without the indentation, the source line
// number it starts (null for the wrapped rest of a long line), how far its
// source line is indented (where the indent guides go), and how far in the
// text itself starts (deeper for a wrapped rest). A blank line takes the
// indent of the block around it, so a guide runs on through it.
export type CodeRow = {
  text: string
  number: number | null
  indent: number
  textIndent: number
}

export type Measure = (text: string) => number

// The widest the indentation of a row may be, so a deeply nested line keeps
// room for its text.
const MAX_INDENT_SHARE = 0.6

// Where to cut `text` so the front fits `room` pixels: at the last space if
// that is not too far back, else mid-word. At least one character, so
// wrapping always moves on.
function cutPoint(text: string, room: number, measure: Measure): number {
  if (measure(text) <= room) return text.length
  let fit = 1
  while (fit < text.length && measure(text.slice(0, fit + 1)) <= room) fit++
  const space = text.lastIndexOf(' ', fit - 1)
  return space > fit * 0.5 ? space + 1 : fit
}

// Rows no wider than maxPx, counting their indentation at cellPx a column. A
// long line breaks and carries on two columns deeper than it started, so a
// continuation is never mistaken for a line of its own. Tabs count as two
// spaces.
export function layoutCodeRows(
  code: string,
  maxPx: number,
  measure: Measure,
  cellPx: number,
): CodeRow[] {
  const widest = Math.max(1, Math.floor((maxPx * MAX_INDENT_SHARE) / cellPx))
  const rows: CodeRow[] = []
  let number = 0
  for (const raw of code.replace(/\t/g, '  ').split('\n')) {
    number++
    const line = raw.replace(/\s+$/, '')
    if (line === '') {
      // -1: a blank line, filled in below.
      rows.push({ text: '', number, indent: -1, textIndent: 0 })
      continue
    }
    const indent = line.length - line.trimStart().length
    let rest = line.trimStart()
    let textIndent = Math.min(indent, widest)
    let first = true
    while (rest.length > 0) {
      const cut = cutPoint(rest, maxPx - textIndent * cellPx, measure)
      rows.push({
        text: rest.slice(0, cut).trimEnd(),
        number: first ? number : null,
        indent,
        textIndent,
      })
      rest = rest.slice(cut).trimStart()
      if (first) textIndent = Math.min(textIndent + 2, widest)
      first = false
    }
  }
  while (rows.length > 0 && rows[rows.length - 1].text === '') rows.pop()
  return fillBlankIndents(rows)
}

function fillBlankIndents(rows: CodeRow[]): CodeRow[] {
  let before = 0
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].indent >= 0) {
      before = rows[i].indent
      continue
    }
    let after = 0
    for (let j = i + 1; j < rows.length; j++) {
      if (rows[j].indent >= 0) {
        after = rows[j].indent
        break
      }
    }
    rows[i] = { ...rows[i], indent: Math.min(before, after) }
  }
  return rows
}

// One indent step: the smallest indentation the code uses, between two and
// four columns, so the guides line up with how the code is written.
export function indentUnit(rows: readonly CodeRow[]): number {
  let unit = 0
  for (const r of rows) if (r.indent > 0 && (unit === 0 || r.indent < unit)) unit = r.indent
  return Math.min(4, Math.max(2, unit))
}

// Screens of `rows` rows each. The next screen starts on the very next row,
// nothing repeated (G2-117, as the text pages do) - the line numbers keep
// the place.
export function codeScreens<T>(rows: T[], perScreen: number): T[][] {
  if (rows.length <= perScreen) return [rows]
  const screens: T[][] = []
  for (let start = 0; start < rows.length; start += perScreen) {
    screens.push(rows.slice(start, start + perScreen))
  }
  return screens
}
