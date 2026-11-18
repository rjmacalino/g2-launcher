import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { askModel } from '../src/core/llm'
import { CHAT_INSTRUCTION, WEARER_INSTRUCTION } from '../src/core/llmTypes'
import { splitAnswer } from '../src/shared/answerBlocks'
import { DEFAULT_LOCAL_INSTRUCTIONS } from '../src/shared/localBrief'
import { MODES, type ModeId } from '../src/shared/modePresets'
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
]

const SAMPLE_PROFILE = 'ABOUT ME (sample). I am a full-stack web developer learning Python.'

function codeOf(answer: string): string {
  return splitAnswer(answer)
    .filter(b => b.kind === 'code')
    .map(b => b.text)
    .join('\n\n')
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
const log: unknown[] = []
for (const modeId of (onlyMode ? [onlyMode] : ['coding', 'interview']) as ModeId[]) {
  const mode = MODES.find(m => m.id === modeId)!
  const preset = modeId === 'interview' ? `${mode.preset}\n\n${SAMPLE_PROFILE}` : mode.preset
  for (const problem of PROBLEMS) {
    const began = Date.now()
    const reply = await askModel(config, [{ role: 'user', text: problem.spoken }], {
      instruction: modeId === 'interview' ? WEARER_INSTRUCTION : CHAT_INSTRUCTION,
      guide: [DEFAULT_LOCAL_INSTRUCTIONS, preset].filter(Boolean).join('\n\n'),
    })
    const seconds = ((Date.now() - began) / 1000).toFixed(1)
    const text = reply.kind === 'answer' ? reply.text : JSON.stringify(reply)
    const result = grade(problem, codeOf(text))
    total++
    if (result === 'PASS') passed++
    log.push({
      provider,
      model: config.model,
      mode: modeId,
      problem: problem.name,
      seconds,
      result,
      text,
    })
    console.log(
      `${result.startsWith('PASS') ? 'PASS' : 'FAIL'} ${mode.label} | ${problem.name} | ${seconds}s`,
    )
    if (result !== 'PASS') console.log(`     ${result}`)
  }
}
const file = `bench/results/coding-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
writeFileSync(file, JSON.stringify(log, null, 2))
console.log(`\n${passed}/${total} passed. Full answers: ${file}`)
process.exit(0)
