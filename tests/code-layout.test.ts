import { describe, expect, it } from 'vitest'
import { codeScreens, indentUnit, layoutCodeRows } from '../src/shared/codeLayout'

// A stand-in for the real measuring: every character 6 pixels wide, so the
// widths in these tests are easy to count. One indent column is 6 pixels.
const measure = (text: string) => text.length * 6
const CELL = 6
const rowsOf = (code: string, maxChars: number) =>
  layoutCodeRows(code, maxChars * CELL, measure, CELL)

describe('layoutCodeRows', () => {
  it('keeps short lines, and counts their indentation in columns instead of spaces', () => {
    const rows = rowsOf('def f():\n  return 1\n\tpass', 40)
    expect(rows.map(r => r.text)).toEqual(['def f():', 'return 1', 'pass'])
    expect(rows.map(r => r.textIndent)).toEqual([0, 2, 2])
  })

  it('wraps a long line, carrying on two columns deeper than it started', () => {
    const rows = rowsOf(`    ${'x'.repeat(30)}`, 20)
    expect(rows.length).toBeGreaterThan(1)
    expect(rows[0].textIndent).toBe(4)
    expect(rows.slice(1).every(r => r.textIndent === 6)).toBe(true)
    for (const r of rows)
      expect(measure(r.text) + r.textIndent * CELL).toBeLessThanOrEqual(20 * CELL)
    expect(rows.map(r => r.text).join('')).toBe('x'.repeat(30))
  })

  it('breaks at a space when it can, so words are not cut in half', () => {
    const rows = rowsOf('one two three four five six seven eight nine ten', 20)
    expect(rows.every(r => !r.text.startsWith(' ') && !r.text.endsWith(' '))).toBe(true)
    expect(rows.map(r => r.text).join(' ')).toBe('one two three four five six seven eight nine ten')
  })

  it('drops trailing blank lines', () => {
    expect(rowsOf('a\n\n\n', 10).map(r => r.text)).toEqual(['a'])
  })

  it('keeps a very deeply indented line from using up its whole width', () => {
    const rows = rowsOf(`${' '.repeat(60)}value = 1`, 30)
    expect(rows[0].textIndent).toBe(18)
    expect(rows.map(r => r.text).join(' ')).toBe('value = 1')
  })
})

describe('layoutCodeRows numbering and guides (G2-117)', () => {
  it('numbers each source line, and gives the wrapped rest of a line no number', () => {
    const rows = rowsOf(`a\n  ${'x'.repeat(30)}\nb`, 20)
    expect(rows.map(r => r.number)).toEqual([1, 2, null, 3])
  })

  it('records the source indent for every row, also the wrapped rest', () => {
    const rows = rowsOf(`def f():\n    ${'x'.repeat(30)}`, 20)
    expect(rows.map(r => r.indent)).toEqual([0, 4, 4])
  })

  it('lets a blank line inside a block carry the block guides through', () => {
    const rows = rowsOf('if x:\n  a = 1\n\n  b = 2\n\nz = 3', 40)
    expect(rows.map(r => r.indent)).toEqual([0, 2, 2, 2, 0, 0])
  })

  it('works out the indent step the code uses', () => {
    expect(indentUnit(rowsOf('a\n    b\n        c', 40))).toBe(4)
    expect(indentUnit(rowsOf('a\n  b\n    c', 40))).toBe(2)
    expect(indentUnit(rowsOf('a\nb', 40))).toBe(2)
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
