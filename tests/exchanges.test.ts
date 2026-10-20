import { describe, expect, it } from 'vitest'
import { exchangesOf, historyRows, HISTORY_MAX_ROWS } from '../src/features/chat/exchanges'
import type { ChatMessage } from '../src/features/chat/store'

const user = (text: string): ChatMessage => ({ role: 'user', text, timestamp: 0 })
const model = (text: string): ChatMessage => ({ role: 'model', text, timestamp: 1 })

describe('exchangesOf (G2-102)', () => {
  it('pairs each question with its answer', () => {
    const ex = exchangesOf([user('a'), model('A'), user('b'), model('B')])
    expect(ex.map(e => [e.question?.text, e.answer?.text])).toEqual([
      ['a', 'A'],
      ['b', 'B'],
    ])
  })

  it('keeps an unanswered last question, and an answer with no question', () => {
    expect(exchangesOf([user('a'), model('A'), user('b')]).at(-1)).toEqual({
      question: user('b'),
      answer: null,
    })
    expect(exchangesOf([model('hi')])).toEqual([{ question: null, answer: model('hi') }])
  })
})

describe('historyRows', () => {
  it('lists the newest exchange first, numbered by its place in the conversation', () => {
    const rows = historyRows(exchangesOf([user('first'), model('1'), user('second'), model('2')]))
    expect(rows).toEqual([
      { label: '2. second', index: 1 },
      { label: '1. first', index: 0 },
    ])
  })

  it('shortens a long question and caps the list', () => {
    const long = 'word '.repeat(40)
    const rows = historyRows(exchangesOf([user(long), model('x')]))
    expect(rows[0].label.length).toBeLessThanOrEqual(44)
    const many = Array.from({ length: 30 }, (_, i) => [user(`q${i}`), model('a')]).flat()
    const capped = historyRows(exchangesOf(many))
    expect(capped).toHaveLength(HISTORY_MAX_ROWS)
    expect(capped[0].index).toBe(29)
  })
})
