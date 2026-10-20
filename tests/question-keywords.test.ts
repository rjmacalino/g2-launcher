import { describe, expect, it } from 'vitest'
import { QUESTION_FULL_MAX_CHARS, questionLine } from '../src/shared/questionKeywords'

describe('questionLine (G2-100)', () => {
  it('shows a short question as it is', () => {
    expect(questionLine('How do I reverse a list in Python?')).toBe(
      'How do I reverse a list in Python?',
    )
    expect(questionLine('  What   time\nis it? ')).toBe('What time is it?')
  })

  it('boils a long question down to its key words, in the order they came', () => {
    const q = `you are given a list of containing the scores of three players

scores = [...]

your program needs to do the ff:

1. print the first player score
2. print the last player score using negative indexing
3. change the score of the 2nd player to 72
4. print the number of scores in the list
5. add a new player's score of 88
6. print the final list`
    const line = questionLine(q)
    expect(line.length).toBeLessThanOrEqual(QUESTION_FULL_MAX_CHARS)
    expect(line.endsWith('...')).toBe(true)
    for (const word of ['scores', 'player', 'print', 'list']) expect(line).toContain(word)
    expect(line).not.toMatch(/\b(the|of|to)\b/)
  })

  it('keeps names and code-like words', () => {
    const line = questionLine(
      'LeetCode Two Sum: given an array of integers and a target, return the indices of the two numbers that add up to the target. Solve it in Python.',
    )
    expect(line).toContain('LeetCode')
    expect(line).toContain('Python')
  })

  it('never returns an empty line for a long question of filler words', () => {
    const filler = 'and the of to a is it so '.repeat(12)
    const line = questionLine(filler)
    expect(line.length).toBeGreaterThan(3)
    expect(line.length).toBeLessThanOrEqual(QUESTION_FULL_MAX_CHARS)
  })
})
