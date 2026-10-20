import { questionLine } from '../../shared/questionKeywords'
import type { ChatMessage } from './store'

// A conversation as question-and-answer pairs (G2-102), for the glasses'
// list of exchanges. Pure, tested in tests/exchanges.test.ts.
export type Exchange = { question: ChatMessage | null; answer: ChatMessage | null }

export function exchangesOf(messages: readonly ChatMessage[]): Exchange[] {
  const out: Exchange[] = []
  for (const message of messages) {
    const last = out[out.length - 1]
    if (message.role === 'user') out.push({ question: message, answer: null })
    else if (last && last.answer === null) last.answer = message
    else out.push({ question: null, answer: message })
  }
  return out
}

// A list holds 20 rows at most (docs/platform.md).
export const HISTORY_MAX_ROWS = 20
const ROW_MAX_CHARS = 44

// Rows for the list, newest first: the exchange's number in the
// conversation and its question line, so the list also says where each one
// sits. index is the exchange's place in exchangesOf's result.
export function historyRows(exchanges: readonly Exchange[]): { label: string; index: number }[] {
  const rows: { label: string; index: number }[] = []
  for (let index = exchanges.length - 1; index >= 0 && rows.length < HISTORY_MAX_ROWS; index--) {
    const e = exchanges[index]
    const text = questionLine(e.question?.text ?? e.answer?.text ?? '')
    const label = `${index + 1}. ${text}`
    rows.push({
      label: label.length > ROW_MAX_CHARS ? `${label.slice(0, ROW_MAX_CHARS - 3)}...` : label,
      index,
    })
  }
  return rows
}
