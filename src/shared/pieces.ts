// Where to cut a recording into pieces that are transcribed while the
// wearer is still talking (G2-82), so stopping leaves only the last piece
// to wait for. Pure, for tests (tests/pieces.test.ts).
//
// A piece is cut once it holds at least minSamples of audio, at the
// quietest frame in its later part (searchFromSamples onwards): the
// likeliest gap between words, so a word is rarely split in two.

export type PieceRule = {
  // Audio a piece must hold before it is cut.
  minSamples: number
  // The cut is never earlier than this far into the piece.
  searchFromSamples: number
}

// The index of the frame to end the piece after, or null when the audio
// since `from` is too short to cut yet. sizes are each frame's sample
// count, levels its loudness.
export function pickCut(
  sizes: readonly number[],
  levels: readonly number[],
  from: number,
  rule: PieceRule,
): number | null {
  let total = 0
  for (let i = from; i < sizes.length; i++) total += sizes[i]
  if (total < rule.minSamples) return null
  let at = 0
  let best: number | null = null
  for (let i = from; i < sizes.length; i++) {
    at += sizes[i]
    if (at < rule.searchFromSamples) continue
    if (best === null || levels[i] < levels[best]) best = i
  }
  return best
}
