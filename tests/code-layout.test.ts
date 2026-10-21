import { describe, expect, it } from 'vitest'
import { codeScreens, indentUnit, layoutCode, layoutCodeRows } from '../src/shared/codeLayout'

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

describe('layoutCodeRows (G2-117)', () => {
  it('numbers each source line, and gives the wrapped rest of a line no number', () => {
    const rows = layoutCodeRows(`a\n  ${'x'.repeat(30)}\nb`, 20)
    expect(rows.map(r => r.number)).toEqual([1, 2, null, 3])
  })

  it('records how far each line is indented, also for the wrapped rest', () => {
    const rows = layoutCodeRows(`def f():\n    ${'x'.repeat(30)}`, 20)
    expect(rows.map(r => r.indent)).toEqual([0, 4, 4])
  })

  it('lets a blank line inside a block carry the block guides through', () => {
    const rows = layoutCodeRows('if x:\n  a = 1\n\n  b = 2\n\nz = 3', 40)
    expect(rows.map(r => r.indent)).toEqual([0, 2, 2, 2, 0, 0])
  })

  it('works out the indent step the code uses', () => {
    expect(indentUnit(layoutCodeRows('a\n    b\n        c', 40))).toBe(4)
    expect(indentUnit(layoutCodeRows('a\n  b\n    c', 40))).toBe(2)
    expect(indentUnit(layoutCodeRows('a\nb', 40))).toBe(2)
  })
})

describe('codeScreens', () => {
  it('keeps a short block on one screen', () => {
    expect(codeScreens(['a', 'b'], 5)).toEqual([['a', 'b']])
  })

  it('starts each screen on the very next row, repeating nothing', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `l${i}`)
    const screens = codeScreens(lines, 5)
    expect(screens[0]).toEqual(['l0', 'l1', 'l2', 'l3', 'l4'])
    expect(screens[1][0]).toBe('l5')
    expect(screens.flat()).toEqual(lines)
    expect(screens.every(s => s.length <= 5)).toBe(true)
  })
})
