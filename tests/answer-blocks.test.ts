import { describe, expect, it } from 'vitest'
import { splitAnswer } from '../src/shared/answerBlocks'

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

  it('finds code with its explanation in the same paragraph (G2-94)', () => {
    const code = 'def fib(n):\n  a, b = 0, 1\n  for _ in range(n):\n    a, b = b, a + b\n  return a'
    expect(splitAnswer(`${code}\nThis approach uses constant memory space.`)).toEqual([
      { kind: 'code', text: code },
      { kind: 'text', text: 'This approach uses constant memory space.' },
    ])
    expect(splitAnswer(`Here is one way to do it in Python:\n${code}`)).toEqual([
      { kind: 'text', text: 'Here is one way to do it in Python:' },
      { kind: 'code', text: code },
    ])
  })

  it('keeps a line with a trailing comment in the code (G2-97)', () => {
    const code = 'nums = [1, 2, 3]\nnums = nums[::-1]\nprint(nums)  # Outputs: [3, 2, 1]'
    expect(splitAnswer(`${code}\nA step of -1 walks the list backwards.`)).toEqual([
      { kind: 'code', text: code },
      { kind: 'text', text: 'A step of -1 walks the list backwards.' },
    ])
  })

  it('leaves a paragraph that only mentions code as text', () => {
    const answer = 'Use a dictionary. For each number, check if target - n was seen.'
    expect(splitAnswer(answer)).toEqual([{ kind: 'text', text: answer }])
  })

  it('treats fenced blocks as code and drops the fences', () => {
    const blocks = splitAnswer('Here you go:\n\n```js\nconst x = 1;\n```')
    expect(blocks).toEqual([
      { kind: 'text', text: 'Here you go:' },
      { kind: 'code', text: 'const x = 1;' },
    ])
  })
})
