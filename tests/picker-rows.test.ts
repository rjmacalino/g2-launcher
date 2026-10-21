import { describe, expect, it } from 'vitest'
import { chatToDelete, deletePrompt } from '../src/features/chat/pickerRows'
import type { ChatSession } from '../src/features/chat/store'

const session = (id: string, title: string): ChatSession => ({
  id,
  title,
  updatedAt: 0,
  messages: [],
})

describe('chatToDelete (G2-108)', () => {
  const list = [session('a', 'First'), session('b', 'Second')]

  it('is the saved chat for a row after "New chat"', () => {
    expect(chatToDelete(1, list)?.id).toBe('a')
    expect(chatToDelete(2, list)?.id).toBe('b')
  })

  it('is nothing for "New chat", a missing row, or a bad row', () => {
    expect(chatToDelete(0, list)).toBeNull()
    expect(chatToDelete(3, list)).toBeNull()
    expect(chatToDelete(-1, list)).toBeNull()
    expect(chatToDelete(Number.NaN, list)).toBeNull()
  })
})

describe('deletePrompt', () => {
  it('names the chat and keeps a long title to one row', () => {
    expect(deletePrompt('Capital of France')).toBe('Delete "Capital of France"?')
    const long = deletePrompt('A very long chat title that will not fit on one row')
    expect(long.length).toBeLessThanOrEqual(36)
    expect(deletePrompt('   ')).toBe('Delete "(untitled)"?')
  })
})
