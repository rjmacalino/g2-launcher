// Splits an answer into prose and code (G2-72), so the phone can show code
// in a monospace box with a copy button. Jarvis is told to answer in plain
// text without code fences (it is read on the glasses too), so code is
// recognised by its shape: a block - lines between blank lines - where most
// lines look like code. Pure, unit-tested in tests/answer-blocks.test.ts.

export type AnswerBlock = { kind: 'text' | 'code'; text: string }

const CODE_LINE =
  /^\s{2,}\S|[{};]\s*$|^\s*(def|class|function|const|let|var|return|if|for|while|else|elif|import|from|public|private|static|int|void|func|fn)\b|\w+\(.*\)\s*:?$|^\s*[}\])]+;?$| = |=>|==|!=/

// A code line, judged without a trailing comment (G2-97: "print(x)  #
// Outputs: [3, 2, 1]" read as prose because the comment hid the call).
function isCodeLine(line: string): boolean {
  return CODE_LINE.test(line.replace(/\s+(#|\/\/).*$/, ''))
}

function looksLikeCode(lines: string[]): boolean {
  const meaningful = lines.filter(l => l.trim() !== '')
  if (meaningful.length === 0) return false
  const codeLike = meaningful.filter(isCodeLine).length
  // Prose sentences end in full stops and run long; code lines rarely do.
  // A comment line is not a sentence of prose, whatever it ends with (G2-117).
  const comment = /^\s*(\/\/|#|\/\*|\*)/
  const sentences = meaningful.filter(
    l => !comment.test(l) && /[a-z]{3,}[.!?]$/i.test(l.trim()) && l.length > 50,
  ).length
  return codeLike / meaningful.length >= 0.6 && sentences === 0
}

// A plain sentence: not indented, no code punctuation, and either ends
// like a sentence or runs to several words.
function isProseLine(line: string): boolean {
  if (/^\s/.test(line) || isCodeLine(line)) return false
  const words = line.trim().split(/\s+/).length
  return /[.!?]$/.test(line.trim()) || words >= 6
}

// A paragraph with code in the middle and sentences only before or after
// it (G2-94: the PC model writes "def ...", "  return a", "This approach
// uses ..." with no blank line between) is split there, so the code is
// still found.
function separateProse(lines: string[]): string[][] {
  const first = lines.findIndex(isCodeLine)
  const last = lines.length - 1 - [...lines].reverse().findIndex(isCodeLine)
  if (first < 0 || last - first < 1) return [lines]
  const before = lines.slice(0, first)
  const after = lines.slice(last + 1)
  if (!before.every(isProseLine) || !after.every(isProseLine)) return [lines]
  return [before, lines.slice(first, last + 1), after].filter(part => part.length > 0)
}

export function splitAnswer(text: string): AnswerBlock[] {
  // Fenced blocks, if a model uses them anyway, are code by definition.
  const unfenced = text.replace(/^```[\w+-]*\s*$/gm, '')
  const blocks: AnswerBlock[] = []
  const chunks = unfenced
    .split(/\n\s*\n/)
    .flatMap(chunk => separateProse(chunk.replace(/\s+$/, '').split('\n')))
  for (const lines of chunks) {
    if (lines.every(l => l.trim() === '')) continue
    const kind = looksLikeCode(lines) ? 'code' : 'text'
    const last = blocks[blocks.length - 1]
    const body = lines.join('\n')
    // Neighbouring code blocks are one program with a blank line inside.
    if (last && last.kind === kind) last.text += `\n\n${body}`
    else blocks.push({ kind, text: body })
  }
  return blocks
}
