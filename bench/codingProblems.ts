import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { askModel } from '../src/core/llm'
import { WEARER_INSTRUCTION } from '../src/core/llmTypes'
import { splitAnswer } from '../src/shared/answerBlocks'
import { DEFAULT_LOCAL_INSTRUCTIONS } from '../src/shared/localBrief'
import { MODES, type ModeId } from '../src/shared/modePresets'
import defaults from '../src/defaults/instructions.json'
import { llmFromEnv } from './llmEnv'

// LeetCode and HackerRank problems as they arrive on the glasses: read aloud,
// through speech recognition, starter code included (G2-151). Each answer's
// code is pulled out the way the glasses split it (shared/answerBlocks.ts)
// and RUN in Python against the problem's tests - a pass means the code is
// right, not that it looks right. Needs Python on the PATH and a key in
// .env.local. Run: npx tsx bench/codingProblems.ts [deepseek|gemini] [mode]

type Problem = {
  name: string
  spoken: string
  // Python run after the answer's code; prints PASS or raises.
  check?: string
  // For a read-stdin problem: input and the exact expected output.
  stdin?: { input: string; output: string }[]
  // The code must build its text with an f-string, not + (G2-194).
  fString?: boolean
}

const PROBLEMS: Problem[] = [
  {
    name: 'LeetCode Two Sum (spoken starter)',
    spoken:
      'Two sum. Given an array of integers nums and an integer target, return indices of ' +
      'the two numbers such that they add up to target. You may assume that each input ' +
      'would have exactly one solution, and you may not use the same element twice. ' +
      'Example one: nums equals 2, 7, 11, 15, target equals 9, output 0, 1. Constraints: ' +
      'nums length is between 2 and 10 to the 4. Starter code: class Solution colon, def ' +
      'two sum open bracket self comma nums colon list open square bracket int close ' +
      'square bracket comma target colon int close bracket arrow list of int colon.',
    check: `
f = getattr(Solution(), 'twoSum', None) or getattr(Solution(), 'two_sum')
assert sorted(f([2, 7, 11, 15], 9)) == [0, 1]
assert sorted(f([3, 2, 4], 6)) == [1, 2]
assert sorted(f([3, 3], 6)) == [0, 1]
big = list(range(100000))
assert sorted(f(big, 199997)) == [99998, 99999]
print('PASS')`,
  },
  {
    name: 'HackerRank Simple Array Sum (stdin)',
    spoken:
      'Simple array sum. Given an array of integers, find the sum of its elements. Input ' +
      'format: the first line contains an integer n, the size of the array. The second ' +
      'line contains n space separated integers representing the array elements. Output ' +
      'format: print the sum of the array elements as a single integer. Sample input: 6, ' +
      'new line, 1 2 3 4 10 11. Sample output: 31.',
    stdin: [
      { input: '6\n1 2 3 4 10 11\n', output: '31' },
      { input: '3\n-1 5 0\n', output: '4' },
    ],
  },
  {
    name: 'HackerRank Diagonal Difference (function template)',
    spoken:
      'Diagonal difference. Given a square matrix, calculate the absolute difference ' +
      'between the sums of its diagonals. Complete the diagonal difference function. It ' +
      'has one parameter, arr, an array of integer arrays. It must return an integer, the ' +
      'absolute diagonal difference. Starter code: def diagonal difference open bracket arr ' +
      'close bracket colon, hash write your code here. Sample: the matrix 11 2 4, 4 5 6, ' +
      '10 8 minus 12 gives 15.',
    check: `
f = globals().get('diagonalDifference') or globals().get('diagonal_difference')
assert f([[11, 2, 4], [4, 5, 6], [10, 8, -12]]) == 15
assert f([[1]]) == 0
assert f([[1, 2], [3, 4]]) == 0
print('PASS')`,
  },
  {
    name: 'LeetCode Longest Substring (constraints decide)',
    spoken:
      'Longest substring without repeating characters. Given a string s, find the length ' +
      'of the longest substring without repeating characters. Example: s equals abcabcbb, ' +
      'output 3. Example: s equals bbbbb, output 1. Constraints: 0 is less than or equal to ' +
      's length, less than or equal to 5 times 10 to the 4. Starter code: class Solution, ' +
      'def length of longest substring, self, s colon str, arrow int.',
    check: `
import random, time
s = Solution()
f = getattr(s, 'lengthOfLongestSubstring', None) or getattr(s, 'length_of_longest_substring')
assert f('abcabcbb') == 3
assert f('bbbbb') == 1
assert f('pwwkew') == 3
assert f('') == 0
assert f(' ') == 1
big = ''.join(random.choice('abcdefghijklmnopqrstuvwxyz') for _ in range(50000))
t = time.time(); f(big); assert time.time() - t < 2, 'too slow for 5 * 10^4'
print('PASS')`,
  },
  {
    name: 'LeetCode Maximum Subarray (negatives, 10^5)',
    spoken:
      'Maximum subarray. Given an integer array nums, find the subarray with the largest ' +
      'sum, and return its sum. Example: nums equals minus 2, 1, minus 3, 4, minus 1, 2, 1, ' +
      'minus 5, 4, output 6. Constraints: 1 is less than or equal to nums length, less than ' +
      'or equal to 10 to the 5. Starter code: class Solution, def max sub array, self, nums ' +
      'colon list of int, arrow int.',
    check: `
import random, time
s = Solution()
f = getattr(s, 'maxSubArray', None) or getattr(s, 'max_sub_array')
assert f([-2, 1, -3, 4, -1, 2, 1, -5, 4]) == 6
assert f([1]) == 1
assert f([-3, -1, -2]) == -1
big = [random.randint(-10000, 10000) for _ in range(100000)]
t = time.time(); f(big); assert time.time() - t < 2, 'too slow for 10^5'
print('PASS')`,
  },
  {
    name: 'Valid Parentheses (stack)',
    spoken:
      'Valid parentheses. Given a string s containing only round, square and curly brackets, ' +
      'return true if every opening bracket is closed by the same type of bracket in the ' +
      'correct order. Example: open round close round open square close square gives true; ' +
      'open round close square gives false. Constraints: s length up to 10 to the 4. Starter ' +
      'code: class Solution, def is valid, self, s colon str, arrow bool.',
    check: `
f = getattr(Solution(), 'isValid', None) or getattr(Solution(), 'is_valid')
assert f('()[]{}') is True
assert f('(]') is False
assert f('([)]') is False
assert f('{[]}') is True
assert f('(') is False
assert f(']') is False
print('PASS')`,
  },
  {
    name: 'Binary Search (sorted input)',
    spoken:
      'Binary search. Given a sorted array of distinct integers nums and a target, return the ' +
      'index of target, or minus 1 if it is not there. You must write an algorithm with O of ' +
      'log n runtime. Example: nums minus 1, 0, 3, 5, 9, 12 and target 9 gives 4. Starter ' +
      'code: class Solution, def search, self, nums colon list of int, target colon int, ' +
      'arrow int.',
    check: `
f = Solution().search
assert f([-1, 0, 3, 5, 9, 12], 9) == 4
assert f([-1, 0, 3, 5, 9, 12], 2) == -1
assert f([5], 5) == 0
assert f([5], -5) == -1
assert f([1, 3], 3) == 1
print('PASS')`,
  },
  {
    name: 'Merge Intervals (sort and sweep)',
    spoken:
      'Merge intervals. Given a list of intervals, each a pair of start and end, merge all ' +
      'overlapping intervals and return the non-overlapping intervals that cover them. ' +
      'Example: 1 3, 2 6, 8 10, 15 18 gives 1 6, 8 10, 15 18. Intervals that touch, like 1 4 ' +
      'and 4 5, merge into 1 5. The input is not sorted. Constraints: up to 10 to the 4 ' +
      'intervals. Starter code: class Solution, def merge, self, intervals colon list of list ' +
      'of int, arrow list of list of int.',
    check: `
f = Solution().merge
assert [list(x) for x in f([[1, 3], [2, 6], [8, 10], [15, 18]])] == [[1, 6], [8, 10], [15, 18]]
assert [list(x) for x in f([[1, 4], [4, 5]])] == [[1, 5]]
assert [list(x) for x in f([[4, 7], [1, 4]])] == [[1, 7]]
assert [list(x) for x in f([[1, 4], [2, 3]])] == [[1, 4]]
print('PASS')`,
  },
  {
    name: 'Number of Islands (grid BFS/DFS)',
    spoken:
      'Number of islands. Given a grid of strings, each 1 for land or 0 for water, return the ' +
      'number of islands. An island is land connected up, down, left or right. Example: the ' +
      'grid 1 1 0, 1 0 0, 0 0 1 has 2 islands. Constraints: up to 300 by 300. Starter code: ' +
      'class Solution, def num islands, self, grid colon list of list of str, arrow int.',
    check: `
import time
s = Solution()
f = getattr(s, 'numIslands', None) or getattr(s, 'num_islands')
assert f([['1','1','0'],['1','0','0'],['0','0','1']]) == 2
assert f([['0']]) == 0
assert f([['1','0','1','0','1']]) == 3
big = [['1'] * 300 for _ in range(300)]
t = time.time(); assert f(big) == 1; assert time.time() - t < 3, 'too slow for 300 x 300'
print('PASS')`,
  },
  {
    name: 'Top K Frequent Elements (heap or buckets)',
    spoken:
      'Top k frequent elements. Given an integer array nums and an integer k, return the k ' +
      'most frequent elements, in any order. Example: nums 1 1 1 2 2 3 and k 2 gives 1 and 2. ' +
      'Constraints: nums length up to 10 to the 5, and the answer is unique. Starter code: ' +
      'class Solution, def top k frequent, self, nums colon list of int, k colon int, arrow ' +
      'list of int.',
    check: `
import random, time
s = Solution()
f = getattr(s, 'topKFrequent', None) or getattr(s, 'top_k_frequent')
assert sorted(f([1, 1, 1, 2, 2, 3], 2)) == [1, 2]
assert f([7], 1) == [7]
big = [i % 1000 for i in range(100000)] + [5] * 500
t = time.time(); assert f(big, 1) == [5]; assert time.time() - t < 2
print('PASS')`,
  },
  {
    name: 'Coin Change (dynamic programming)',
    spoken:
      'Coin change. Given coin denominations coins and a total amount, return the fewest ' +
      'coins that make up that amount, or minus 1 if it cannot be made. You have unlimited ' +
      'coins of each kind. Example: coins 1, 2, 5 and amount 11 gives 3. Example: coins 2 and ' +
      'amount 3 gives minus 1. Constraints: amount up to 10 to the 4, up to 12 coins. Starter ' +
      'code: class Solution, def coin change, self, coins colon list of int, amount colon ' +
      'int, arrow int.',
    check: `
import time
s = Solution()
f = getattr(s, 'coinChange', None) or getattr(s, 'coin_change')
assert f([1, 2, 5], 11) == 3
assert f([2], 3) == -1
assert f([1], 0) == 0
assert f([186, 419, 83, 408], 6249) == 20
t = time.time(); assert f([1, 7, 23, 50], 10000) == 200; assert time.time() - t < 3
print('PASS')`,
  },
  {
    name: 'Subsets (backtracking)',
    spoken:
      'Subsets. Given an array of unique integers nums, return all possible subsets, the ' +
      'power set, with no duplicate subsets, in any order. Example: nums 1, 2, 3 gives 8 ' +
      'subsets: empty, 1, 2, 3, 1 2, 1 3, 2 3, and 1 2 3. Starter code: class Solution, def ' +
      'subsets, self, nums colon list of int, arrow list of list of int.',
    check: `
f = Solution().subsets
got = sorted(sorted(x) for x in f([1, 2, 3]))
assert got == sorted([[], [1], [2], [3], [1, 2], [1, 3], [2, 3], [1, 2, 3]])
assert sorted(sorted(x) for x in f([0])) == [[], [0]]
assert len(f(list(range(10)))) == 1024
print('PASS')`,
  },
  {
    name: 'Course Schedule (graph, cycle detection)',
    spoken:
      'Course schedule. There are num courses courses, labelled 0 to num courses minus 1. ' +
      'You are given prerequisites, where a pair a, b means you must take b before a. Return ' +
      'true if you can finish all courses. Example: 2 courses with prerequisite 1, 0 gives ' +
      'true. Example: 2 courses with prerequisites 1, 0 and 0, 1 gives false. Constraints: up ' +
      'to 2000 courses and 5000 prerequisites. Starter code: class Solution, def can finish, ' +
      'self, num courses colon int, prerequisites colon list of list of int, arrow bool.',
    check: `
import time
s = Solution()
f = getattr(s, 'canFinish', None) or getattr(s, 'can_finish')
assert f(2, [[1, 0]]) is True
assert f(2, [[1, 0], [0, 1]]) is False
assert f(3, []) is True
assert f(4, [[1, 0], [2, 1], [3, 2], [1, 3]]) is False
chain = [[i + 1, i] for i in range(1999)]
t = time.time(); assert f(2000, chain) is True; assert time.time() - t < 2
print('PASS')`,
  },
  {
    name: 'Product of Array Except Self (prefix and suffix)',
    spoken:
      'Product of array except self. Given an integer array nums, return an array answer ' +
      'where answer at i is the product of all elements except nums at i. You must not use ' +
      'division and must run in O of n. Example: 1, 2, 3, 4 gives 24, 12, 8, 6. Example with ' +
      'a zero: minus 1, 1, 0, minus 3, 3 gives 0, 0, 9, 0, 0. Constraints: up to 10 to the 5 ' +
      'elements. Starter code: class Solution, def product except self, self, nums colon ' +
      'list of int, arrow list of int.',
    check: `
import time
s = Solution()
f = getattr(s, 'productExceptSelf', None) or getattr(s, 'product_except_self')
assert list(f([1, 2, 3, 4])) == [24, 12, 8, 6]
assert list(f([-1, 1, 0, -3, 3])) == [0, 0, 9, 0, 0]
big = [1] * 100000
t = time.time(); assert list(f(big)) == big; assert time.time() - t < 2
print('PASS')`,
  },
  {
    name: 'HackerRank Mini-Max Sum (stdin, one line)',
    spoken:
      'Mini max sum. Given five positive integers, find the minimum and maximum values that ' +
      'can be calculated by summing exactly four of the five integers. Print the respective ' +
      'minimum and maximum values as a single line of two space separated long integers. ' +
      'Input format: a single line of five space separated integers. Sample input: 1 2 3 4 5. ' +
      'Sample output: 10 14. Constraints: each value up to 10 to the 9.',
    stdin: [
      { input: '1 2 3 4 5\n', output: '10 14' },
      {
        input: '256741038 623958417 467905213 714532089 938071625\n',
        output: '2063136757 2744467344',
      },
      { input: '5 5 5 5 5\n', output: '20 20' },
    ],
  },
  {
    name: 'HackerRank Birthday Cake Candles (stdin, two lines)',
    spoken:
      'Birthday cake candles. You are in charge of the cake for a child, who can only blow ' +
      'out the tallest candles. Count how many candles are tallest. Input format: the first ' +
      'line contains a single integer n, the number of candles. The second line contains n ' +
      'space separated integers, the candle heights. Output format: print the number of ' +
      'tallest candles. Sample input: 4, new line, 3 2 1 3. Sample output: 2.',
    stdin: [
      { input: '4\n3 2 1 3\n', output: '2' },
      { input: '1\n7\n', output: '1' },
      { input: '6\n1 9 9 9 2 9\n', output: '4' },
    ],
  },
  {
    // Builds a sentence from the input (G2-194): Python must use an f-string.
    name: 'HackerRank greeting (stdin, builds a string)',
    spoken:
      'Greeting. Read a first name on the first line and a last name on the second line, ' +
      'then print exactly: Hello first last! You just delved into python. Sample input: ' +
      'Ross, new line, Taylor. Sample output: Hello Ross Taylor! You just delved into python.',
    stdin: [
      { input: 'Ross\nTaylor\n', output: 'Hello Ross Taylor! You just delved into python.' },
      { input: 'Ada\nLovelace\n', output: 'Hello Ada Lovelace! You just delved into python.' },
    ],
    fString: true,
  },
]

const SAMPLE_PROFILE = 'ABOUT ME (sample). I am a full-stack web developer learning Python.'

// Python shorthand a beginner would have to decode (G2-154): the Code mode
// rules ask for none of it unless there is no simple alternative.
const SHORTHAND: [string, RegExp][] = [
  ['comprehension', /[[{(][^\n\]})]* for [^\n]* in [^\n]*[\]})]/],
  ['lambda', /\blambda\b/],
  ['inline if-else', /^(?!\s*(if|elif|else)\b).*\S.* if .+ else /m],
  ['Counter', /\bCounter\(/],
  ['defaultdict', /\bdefaultdict\(/],
  ['[::-1]', /\[::-1\]/],
  ['map/filter/reduce', /\b(map|filter|reduce)\(/],
  ['zip', /\bzip\(/],
  ['key=', /\bkey\s*=/],
  ['walrus', /:=/],
]

function shorthandIn(code: string): string[] {
  return SHORTHAND.filter(([, pattern]) => pattern.test(code)).map(([name]) => name)
}

// The solution: the longest code block. A walk-through line that merely
// looks like code ("primary += arr[0][0] = 11") is a block of its own and
// would break the program if joined in.
function codeOf(answer: string): string {
  const all = splitAnswer(answer)
  // The block under the "code:" label (G2-186): the pseudocode above it can
  // look like code ("n = size of the matrix") and run longer.
  // The label can be its own block or the last line of the text above.
  const label = all.findIndex(b => b.kind === 'text' && /(^|\n)\s*code:\s*$/i.test(b.text))
  const labelled = label >= 0 ? all.slice(label + 1).find(b => b.kind === 'code') : undefined
  if (labelled) return labelled.text
  const blocks = all.filter(b => b.kind === 'code').map(b => b.text)
  return blocks.reduce((a, b) => (b.length > a.length ? b : a), '')
}

function runPython(code: string, input?: string): { ok: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'g2-coding-'))
  const file = join(dir, 'answer.py')
  writeFileSync(file, `from typing import *\n${code}\n`)
  const run = spawnSync('python', ['-I', file], { input, encoding: 'utf8', timeout: 20_000 })
  return { ok: run.status === 0, out: `${run.stdout ?? ''}${run.stderr ?? ''}`.trim() }
}

function grade(problem: Problem, code: string): string {
  if (!code) return 'FAIL (no code found in the answer)'
  // A string built with + or str() instead of an f-string (G2-194).
  const concatenates = /["']\s*\+|\+\s*["']|\bstr\(/.test(code)
  if (problem.fString && (!/\bf["']/.test(code) || concatenates)) {
    return 'FAIL (builds the string without an f-string)'
  }
  if (problem.stdin) {
    for (const t of problem.stdin) {
      const r = runPython(code, t.input)
      if (r.out !== t.output)
        return `FAIL (stdin ${JSON.stringify(t.input)} gave ${JSON.stringify(r.out.slice(0, 120))})`
    }
    return 'PASS'
  }
  const r = runPython(`${code}\n${problem.check}`)
  return r.ok && r.out.endsWith('PASS')
    ? 'PASS'
    : `FAIL (${r.out.split('\n').slice(-1)[0]?.slice(0, 160)})`
}

const provider = process.argv[2] ?? 'deepseek'
const onlyMode = process.argv[3] as ModeId | undefined
process.env.LLM_PROVIDER = provider
const config = llmFromEnv()
if (!config || config.provider !== provider) {
  console.log(`No ${provider} key in .env.local.`)
  process.exit(1)
}
let passed = 0
let total = 0
let shorthand = 0
const log: unknown[] = []
for (const modeId of [onlyMode ?? 'coding'] as ModeId[]) {
  const mode = MODES.find(m => m.id === modeId)!
  const preset = modeId === 'interview' ? `${mode.preset}\n\n${SAMPLE_PROFILE}` : mode.preset
  for (const problem of PROBLEMS) {
    const began = Date.now()
    const reply = await askModel(config, [{ role: 'user', text: problem.spoken }], {
      instruction: WEARER_INSTRUCTION,
      // As the app sends it for a "New: Python" Code chat (G2-152).
      guide: [
        DEFAULT_LOCAL_INSTRUCTIONS,
        preset,
        defaults.languageRule.split('{language}').join('Python'),
      ]
        .filter(Boolean)
        .join('\n\n'),
    })
    const seconds = ((Date.now() - began) / 1000).toFixed(1)
    const text = reply.kind === 'answer' ? reply.text : JSON.stringify(reply)
    const code = codeOf(text)
    const result = grade(problem, code)
    const tricks = shorthandIn(code)
    total++
    if (result === 'PASS') passed++
    shorthand += tricks.length
    log.push({
      provider,
      model: config.model,
      mode: modeId,
      problem: problem.name,
      seconds,
      result,
      shorthand: tricks,
      text,
    })
    console.log(
      `${result.startsWith('PASS') ? 'PASS' : 'FAIL'} ${mode.label} | ${problem.name} | ${seconds}s` +
        (tricks.length > 0 ? ` | shorthand: ${tricks.join(', ')}` : ''),
    )
    if (result !== 'PASS') console.log(`     ${result}`)
  }
}
const file = `bench/results/coding-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
writeFileSync(file, JSON.stringify(log, null, 2))
console.log(`\n${passed}/${total} passed, ${shorthand} shorthand uses. Full answers: ${file}`)
process.exit(0)
