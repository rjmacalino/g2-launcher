import { describe, expect, it } from 'vitest'
import {
  inScope,
  newRowsFor,
  pickerMax,
  pickerTitle,
  sortForPicker,
} from '../src/features/chat/picker'
import type { ChatSession } from '../src/features/chat/store'

// The glasses' chat list per launcher entry (G2-152, G2-172).

function chat(id: string, mode: string | undefined, updatedAt: number): ChatSession {
  return { id, title: id, messages: [], updatedAt, ...(mode ? { mode } : {}) }
}

describe('picker', () => {
  it('starts each entry with its own new-chat rows', () => {
    expect(newRowsFor('jarvis').map(r => r.label)).toEqual(['New chat'])
    expect(newRowsFor('interview').map(r => r.label)).toEqual(['New interview'])
    expect(newRowsFor('code').map(r => r.label)).toEqual([
      'New: Python',
      'New: JavaScript',
      'New: TypeScript',
      'New: C#',
    ])
  })

  it('shows each entry only its own chats', () => {
    const general = chat('g', undefined, 1)
    const interview = chat('i', 'interview', 1)
    const code = chat('c', 'coding', 1)
    expect([general, interview, code].filter(s => inScope(s, 'jarvis'))).toEqual([general])
    expect([general, interview, code].filter(s => inScope(s, 'interview'))).toEqual([interview])
    expect([general, interview, code].filter(s => inScope(s, 'code'))).toEqual([code])
  })

  it('never lets the list pass the firmware limit of 20 rows', () => {
    const many = Array.from({ length: 40 }, (_, i) => chat(`c${i}`, 'coding', i))
    const shown = sortForPicker(many, 'code')
    expect(shown).toHaveLength(pickerMax('code'))
    expect(newRowsFor('code').length + shown.length).toBe(20)
    expect(shown[0].id).toBe('c39')
  })

  it('shortens long titles for the list only', () => {
    expect(pickerTitle('short')).toBe('short')
    const long = 'x'.repeat(60)
    expect(pickerTitle(long)).toHaveLength(40)
    expect(pickerTitle(long).endsWith('...')).toBe(true)
  })
})
