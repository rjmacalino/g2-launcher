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
