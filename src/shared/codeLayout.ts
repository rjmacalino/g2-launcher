// Laying code out for the glasses' code view (G2-73): code is drawn as an
// image in a monospace font (ui/codeRender.ts), so it can be laid out by
// character count - every character the same width, indentation exact.
// Pure; unit-tested in tests/code-layout.test.ts.

// Lines no wider than cols. A long line breaks at cols and carries on
// indented two deeper than where it started, so a continuation is never
// mistaken for a line of its own. Tabs count as two spaces.
export function layoutCode(code: string, cols: number): string[] {
  const out: string[] = []
  for (const raw of code.replace(/\t/g, '  ').split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (line.length <= cols) {
      out.push(line)
      continue
    }
    const indent = line.length - line.trimStart().length
    const carry = ' '.repeat(Math.min(indent + 2, Math.floor(cols / 2)))
    out.push(line.slice(0, cols))
    let rest = line.slice(cols)
    const room = cols - carry.length
    while (rest.length > 0) {
      out.push(carry + rest.slice(0, room))
      rest = rest.slice(room)
    }
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out
}

// Screens of `rows` lines each. The last line of a screen repeats at the top
// of the next, so the eye keeps its place - the same idea as the text
// view's overlap.
export function codeScreens(lines: string[], rows: number): string[][] {
  if (lines.length <= rows) return [lines]
  const screens: string[][] = []
  for (let start = 0; start < lines.length;) {
    screens.push(lines.slice(start, start + rows))
    if (start + rows >= lines.length) break
    start += rows - 1
  }
  return screens
}
