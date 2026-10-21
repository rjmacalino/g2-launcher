// Laying code out for the glasses' code view (G2-73): code is drawn as an
// image in a monospace font (ui/codeRender.ts), so it can be laid out by
// character count - every character the same width, indentation exact.
// Pure; unit-tested in tests/code-layout.test.ts.

// One row of the picture (G2-117): its text, the source line number it
// starts (null for the wrapped rest of a long line), and how far its source
// line is indented, which is where the indent guides go. A blank line takes
// the indent of the block around it, so a guide runs on through it.
export type CodeRow = { text: string; number: number | null; indent: number }

// Rows no wider than cols. A long line breaks at cols and carries on
// indented two deeper than where it started, so a continuation is never
// mistaken for a line of its own. Tabs count as two spaces.
export function layoutCodeRows(code: string, cols: number): CodeRow[] {
  const rows: CodeRow[] = []
  let number = 0
  for (const raw of code.replace(/\t/g, '  ').split('\n')) {
    number++
    const line = raw.replace(/\s+$/, '')
    // -1: a blank line, filled in below.
    const indent = line === '' ? -1 : line.length - line.trimStart().length
    if (line.length <= cols) {
      rows.push({ text: line, number, indent })
      continue
    }
    const carry = ' '.repeat(Math.min(indent + 2, Math.floor(cols / 2)))
    rows.push({ text: line.slice(0, cols), number, indent })
    let rest = line.slice(cols)
    const room = cols - carry.length
    while (rest.length > 0) {
      rows.push({ text: carry + rest.slice(0, room), number: null, indent })
      rest = rest.slice(room)
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

// Just the text, for callers that only need the lines.
export function layoutCode(code: string, cols: number): string[] {
  return layoutCodeRows(code, cols).map(r => r.text)
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
