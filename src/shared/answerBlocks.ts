// Splits an answer into prose and code (G2-72), so the phone can show code
// in a monospace box with a copy button. Jarvis is told to answer in plain
// text without code fences (it is read on the glasses too), so code is
// recognised by its shape: a block - lines between blank lines - where most
// lines look like code. Pure, unit-tested in tests/answer-blocks.test.ts.

export type AnswerBlock = { kind: 'text' | 'code'; text: string }

const CODE_LINE =
  /^\s{2,}\S|[{};]\s*$|^\s*(def|class|function|const|let|var|return|if|for|while|else|elif|import|from|public|private|static|int|void|func|fn)\b|\w+\(.*\)\s*:?$|^\s*[}\])]+;?$| = |=>|==|!=/

function looksLikeCode(lines: string[]): boolean {
  const meaningful = lines.filter(l => l.trim() !== '')
  if (meaningful.length === 0) return false
  const codeLike = meaningful.filter(l => CODE_LINE.test(l)).length
  // Prose sentences end in full stops and run long; code lines rarely do.
  const sentences = meaningful.filter(
    l => /[a-z]{3,}[.!?]$/i.test(l.trim()) && l.length > 50,
  ).length
  return codeLike / meaningful.length >= 0.6 && sentences === 0
}

export function splitAnswer(text: string): AnswerBlock[] {
  // Fenced blocks, if a model uses them anyway, are code by definition.
  const unfenced = text.replace(/^```[\w+-]*\s*$/gm, '')
  const blocks: AnswerBlock[] = []
  for (const chunk of unfenced.split(/\n\s*\n/)) {
    const lines = chunk.replace(/\s+$/, '').split('\n')
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
