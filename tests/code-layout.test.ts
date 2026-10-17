import { describe, expect, it } from 'vitest'
import { codeScreens, layoutCode } from '../src/shared/codeLayout'

describe('layoutCode', () => {
  it('keeps short lines and their indentation exactly', () => {
    expect(layoutCode('def f():\n  return 1\n\tpass', 40)).toEqual([
      'def f():',
      '  return 1',
      '  pass',
    ])
  })

  it('wraps a long line, carrying on two deeper than it started', () => {
    const lines = layoutCode(`    ${'x'.repeat(30)}`, 20)
    expect(lines[0]).toBe(`    ${'x'.repeat(16)}`)
    expect(lines.slice(1).every(l => l.startsWith('      '))).toBe(true)
    expect(lines.every(l => l.length <= 20)).toBe(true)
    expect(lines.join('').replace(/ /g, '')).toBe('x'.repeat(30))
  })

  it('drops trailing blank lines', () => {
    expect(layoutCode('a\n\n\n', 10)).toEqual(['a'])
  })
})

describe('codeScreens', () => {
  it('keeps a short block on one screen', () => {
    expect(codeScreens(['a', 'b'], 5)).toEqual([['a', 'b']])
  })

  it('repeats the last line of a screen at the top of the next', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `l${i}`)
    const screens = codeScreens(lines, 5)
    expect(screens[0]).toEqual(['l0', 'l1', 'l2', 'l3', 'l4'])
    expect(screens[1][0]).toBe('l4')
    expect(screens[screens.length - 1].at(-1)).toBe('l11')
    expect(screens.every(s => s.length <= 5)).toBe(true)
  })
})
