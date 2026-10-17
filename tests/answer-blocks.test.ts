import { describe, expect, it } from 'vitest'
import { splitAnswer } from '../src/companion/answerBlocks'

describe('splitAnswer', () => {
  it('leaves an ordinary answer as text', () => {
    expect(
      splitAnswer('The capital of Australia is Canberra. It became the capital in 1913.'),
    ).toEqual([
      {
        kind: 'text',
        text: 'The capital of Australia is Canberra. It became the capital in 1913.',
      },
    ])
  })

  it('finds unfenced code and the explanation around it', () => {
    const answer = [
      'def two_sum(nums, target):',
      '  seen = {}',
      '  for i, n in enumerate(nums):',
      '    if target - n in seen:',
      '      return [seen[target - n], i]',
      '    seen[n] = i',
      '',
      'This keeps a hash map of numbers already seen, so it runs in one pass: O(n) time.',
    ].join('\n')
    const blocks = splitAnswer(answer)
    expect(blocks.map(b => b.kind)).toEqual(['code', 'text'])
    expect(blocks[0].text.startsWith('def two_sum')).toBe(true)
  })

  it('keeps one program together across a blank line', () => {
    const answer = 'def a():\n  return 1\n\ndef b():\n  return 2'
    expect(splitAnswer(answer)).toEqual([{ kind: 'code', text: answer }])
  })

  it('treats fenced blocks as code and drops the fences', () => {
    const blocks = splitAnswer('Here you go:\n\n```js\nconst x = 1;\n```')
    expect(blocks).toEqual([
      { kind: 'text', text: 'Here you go:' },
      { kind: 'code', text: 'const x = 1;' },
    ])
  })
})
