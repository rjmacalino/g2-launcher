import { status } from './bridge'
import { setContent, setContentPartial } from './page'

// Finds out how much text the glasses really take in one text container
// (G2-115). The docs say 1000 characters on a rebuild and 2000 on an
// in-place update, and the simulator refuses anything over 1000, but nothing
// has been tried on real glasses. Two ways to put in more:
//   single: one update of each size, to find where a single update stops;
//   append: a text built from chunks, each a partial update that replaces
//           the last character with itself plus the chunk (a replace length
//           of zero is dropped on the wire and reads as "replace it all").
// Every step is written to the status line. What stays on the glasses is
// numbered lines, so the first line on screen says which way it went: L0001
// means the chunks were added up, a later number means each one replaced the
// last (the simulator does this, since it ignores partial updates).

const LINE = (n: number) => `L${String(n).padStart(4, '0')} ........................ end`

export function numberedLines(from: number, count: number): string {
  return Array.from({ length: count }, (_, i) => LINE(from + i)).join('\n')
}

export async function probeLongText(kind: 'single' | 'append'): Promise<void> {
  if (kind === 'single') {
    for (const lines of [24, 30, 36, 50, 75, 150]) {
      const text = numberedLines(1, lines)
      const ok = await setContent(text)
      status(`Long text, one update: ${text.length} characters -> ${ok ? 'accepted' : 'REFUSED'}`)
    }
    return
  }
  let text = numberedLines(1, 22)
  let ok = await setContent(text)
  status(`Long text, in chunks: first ${text.length} characters -> ${ok ? 'accepted' : 'REFUSED'}`)
  let next = 23
  for (let round = 1; round <= 8 && ok; round++) {
    const chunk = `\n${numberedLines(next, 22)}`
    ok = await setContentPartial(text[text.length - 1] + chunk, text.length - 1, 1)
    if (ok) {
      text += chunk
      next += 22
    }
    status(
      `Long text, in chunks: round ${round}, ${text.length} characters sent -> ${ok ? 'accepted' : 'REFUSED'}`,
    )
  }
  status(
    'Long text test done: scroll the glasses - the first line should read L0001 if the chunks added up',
  )
}
