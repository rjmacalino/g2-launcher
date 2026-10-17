import { describe, expect, it } from 'vitest'
import { storedTranscript, summaryRequest, summaryTitle } from '../src/features/live/summary'

const lines = [
  { speaker: 'other', text: 'Can you send me the report by Friday?', at: 1 },
  { speaker: 'self', text: 'Sure, I will.', at: 2 },
]

describe('Jarvis Live summary', () => {
  it('asks about the whole transcript, labelled', () => {
    const text = summaryRequest(lines)
    expect(text).toContain('Transcript of the conversation:')
    expect(text).toContain('Them: Can you send me the report by Friday?')
    expect(text).toContain('You: Sure, I will.')
  })

  it('titles the saved conversation with the first sentence of the summary', () => {
    expect(summaryTitle('A catch-up with Sam about the Q3 report. Sam needs it Friday.', 0)).toBe(
      'Live: A catch-up with Sam about the Q3 report.',
    )
  })

  it('falls back to the time when there is no summary', () => {
    expect(summaryTitle(null, new Date(2026, 9, 17, 15, 40).getTime())).toMatch(
      /^Live conversation at 3:40/,
    )
  })

  it('keeps only the end of a long transcript, within the chat store budget', () => {
    const long = Array.from({ length: 200 }, (_, i) => ({
      speaker: 'other',
      text: `line ${i}`,
      at: i,
    }))
    const stored = storedTranscript(long)
    expect(stored.length).toBeLessThanOrEqual(2503)
    expect(stored.endsWith('Them: line 199')).toBe(true)
    expect(stored.startsWith('...')).toBe(true)
  })
})
