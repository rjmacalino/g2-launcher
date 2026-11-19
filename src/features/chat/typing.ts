// How an answer is typed out on the glasses (G2-106): a model writes far
// faster than anyone reads, so the text is revealed at a readable pace and
// the wearer can tap to skip ahead. Pure, tested in tests/typing.test.ts.

// About a fast reader. A thousand characters takes half a minute, so tap to
// skip matters; change here to taste.
export const TYPING_CHARS_PER_SECOND = 30
export const TYPING_TICK_MS = 250

// How much of `text` to show next, given how many characters are already
// shown and how many more the pace allows. Always ends on a word boundary,
// and while the model is still writing, never shows the last word, which
// may still be growing.
export function nextShown(
  text: string,
  shown: number,
  allowance: number,
  complete: boolean,
): number {
  if (shown >= text.length) return text.length
  let end = Math.min(text.length, shown + Math.max(1, Math.floor(allowance)))
  if (end < text.length) {
    // Finish the word that the allowance ends inside of.
    while (end < text.length && !/\s/.test(text[end])) end++
    return end
  }
  if (complete) return text.length
  // Reached the end of what has arrived, with more still to come.
  const space = Math.max(text.lastIndexOf(' '), text.lastIndexOf('\n'))
  return Math.max(shown, space + 1)
}

// THE SAY-IT-NOW SENTENCE (G2-180): in Interview and Code the wearer needs
// something to say at once, so the answer's first sentence is shown whole
// the moment it has arrived, before reading-pace typing takes over. Where
// that sentence ends, or 0 while it is still arriving. A Code reply's header
// line ("LeetCode - Two Sum - Easy") has no full stop, so it is shown with
// the sentence after it. Never more than LEAD_MAX_CHARS, so a reply that
// never ends a sentence still types.
export const LEAD_MAX_CHARS = 300

export function leadSentenceEnd(text: string): number {
  // A sentence end, or a colon ending a line: Code opens with
  // "For this ... problem, use:" (G2-186).
  const match = /[.?!](?=\s|$)|:(?=\n)/.exec(text.slice(0, LEAD_MAX_CHARS))
  if (!match) return 0
  const end = match.index + 1
  // A full stop at the very end of what has arrived may be "3." of "3.5":
  // wait for the next character to know.
  return end < text.length ? end : 0
}
