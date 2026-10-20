// The question line on the glasses (G2-100). A short question is shown as
// it is; a long one is boiled down to its most telling words, so it takes
// a line or two instead of the whole screen. No AI is involved: words are
// ranked by how often they come up, with a bonus for the ones that look
// like names, numbers or code, and shown in the order they first appeared.
// Pure, tested in tests/question-keywords.test.ts.

export const QUESTION_FULL_MAX_CHARS = 70
const KEYWORDS_MAX_WORDS = 8

const STOP_WORDS = new Set(
  (
    'a an the and or but if then else so to of in on at by for with from into onto as is are was were be been being ' +
    'am do does did done have has had having it its this that these those i me my we our you your he she they them ' +
    'his her their what which who whom whose when where why how can could would should will shall may might must ' +
    'not no yes please just also very more most some any each every than too about over under up down out off ' +
    'there here need needs want wants like given give gives make makes using use used ff following following'
  ).split(' '),
)

function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

// Words as the wearer wrote them: letters, digits and the joiners code
// uses, so "two_sum" or "O(n)" stay in one piece.
function tokens(text: string): string[] {
  return text.match(/[A-Za-z0-9_]+(?:[.'-][A-Za-z0-9_]+)*/g) ?? []
}

function stem(word: string): string {
  const w = word.toLowerCase()
  return w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w
}

export function questionLine(question: string): string {
  const text = flat(question)
  if (text.length <= QUESTION_FULL_MAX_CHARS) return text

  const words = tokens(text)
  const count = new Map<string, number>()
  for (const w of words) count.set(stem(w), (count.get(stem(w)) ?? 0) + 1)

  type Entry = { word: string; first: number; score: number }
  const seen = new Map<string, Entry>()
  words.forEach((word, i) => {
    const key = stem(word)
    if (seen.has(key)) return
    if (STOP_WORDS.has(word.toLowerCase()) || word.length < 2) return
    const looksSpecial =
      (/[A-Za-z]/.test(word) && /\d|_|\./.test(word)) ||
      (/^[A-Z]/.test(word) && i > 0 && !/[.!?]$/.test(words[i - 1] ?? ''))
    const score = (count.get(key) ?? 1) + (looksSpecial ? 1 : 0) + (word.length >= 6 ? 0.5 : 0)
    seen.set(key, { word, first: i, score })
  })

  const best = [...seen.values()]
    .sort((a, b) => b.score - a.score || a.first - b.first)
    .slice(0, KEYWORDS_MAX_WORDS)
    .sort((a, b) => a.first - b.first)
    .map(e => e.word)

  let line = ''
  for (const word of best) {
    if ((line ? `${line} ${word}` : word).length > QUESTION_FULL_MAX_CHARS - 3) break
    line = line ? `${line} ${word}` : word
  }
  // The three dots say it was boiled down, not what was asked.
  return line ? `${line}...` : `${text.slice(0, QUESTION_FULL_MAX_CHARS - 3)}...`
}
