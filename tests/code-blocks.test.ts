import { describe, expect, it, vi } from 'vitest'

// codeView.ts measures text through paging.ts and platform/page, which load
// the bridge; there is none under Vitest.
vi.mock('../src/platform/bridge', () => ({ bridge: {}, status: vi.fn() }))

const { blockTopic, codeBlockNames, withCodePlaceholders } =
  await import('../src/features/chat/codeView')
type CodeKind = 'code' | 'pseudo'

// An answer's code and pseudocode blocks for the code view's list (G2-203).

const answer = [
  'For this problem, use:',
  'pseudo code:',
  'read n\nsum the numbers\nprint the sum',
  'code:',
  'n = int(input())\ntotal = 0\nfor x in range(n):\n  total = total + x\nprint(total)',
  'And a second version:',
  'pseudo code:',
  'loop once\nkeep the best',
  'code:',
  'def best(xs):\n  b = xs[0]\n  for x in xs:\n    if x > b:\n      b = x\n  return b',
].join('\n\n')

describe('code blocks of an answer (G2-203)', () => {
  it('collects every pseudocode and code block, in order, with its kind', () => {
    const blocks: string[] = []
    const kinds: CodeKind[] = []
    withCodePlaceholders(answer, blocks, kinds)
    expect(kinds).toEqual(['pseudo', 'code', 'pseudo', 'code'])
    expect(blocks[0]).toBe('read n\nsum the numbers\nprint the sum')
    expect(blocks[3].startsWith('def best(xs):')).toBe(true)
  })

  it('names them by kind, number and what they are about, for the list (G2-204)', () => {
    const blocks: string[] = []
    const kinds: CodeKind[] = []
    withCodePlaceholders(answer, blocks, kinds)
    expect(codeBlockNames(blocks, kinds)).toEqual([
      'Pseudo 1: read n - 3 lines',
      'Code 1: n = int(input()) - 5 lines',
      'Pseudo 2: loop once - 2 lines',
      'Code 2: best() - 6 lines',
    ])
  })

  it('finds the function or class across languages, and fits the list', () => {
    const name = (code: string) => blockTopic(code, 'code')
    expect(name('class Solution:\n  def twoSum(self, nums):\n    pass')).toBe('class Solution')
    expect(name('function reverseString(s) {\n  return s\n}')).toBe('reverseString()')
    expect(name('export async function load() {}')).toBe('load()')
    expect(name('public static int Sum(int[] xs)\n{\n  return 0;\n}')).toBe('Sum()')
    const long = codeBlockNames(['x'.repeat(80)], ['pseudo'])[0]
    expect(long.length).toBeLessThanOrEqual(40)
    expect(long).toMatch(/\.\.\. - 1 lines$/)
  })

  it('takes pseudocode that looks like code ("n = ...") as pseudocode, once', () => {
    const blocks: string[] = []
    const kinds: CodeKind[] = []
    const text = [
      'For this problem, use:',
      'pseudo code:',
      'n = size of the matrix\ntotal = sum of the diagonal\nreturn total',
      'code:',
      'def f(m):\n  n = len(m)\n  return n',
    ].join('\n\n')
    withCodePlaceholders(text, blocks, kinds)
    expect(kinds).toEqual(['pseudo', 'code'])
    expect(blocks[0].startsWith('n = size of the matrix')).toBe(true)
  })

  it('leaves an answer without code untouched', () => {
    const blocks: string[] = []
    expect(withCodePlaceholders('Just words here.', blocks)).toBe('Just words here.')
    expect(blocks).toEqual([])
  })
})
