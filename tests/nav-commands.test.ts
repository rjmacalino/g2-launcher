import { describe, expect, it } from 'vitest'
import { parseNavCommand } from '../src/shared/navCommands'

describe('parseNavCommand (G2-150)', () => {
  it('reads going back, as a spoken double-tap', () => {
    for (const said of [
      'Go back.',
      'back',
      'Exit.',
      'Close this chat.',
      'Leave this chat please.',
    ]) {
      expect(parseNavCommand(said)).toEqual({ kind: 'back' })
    }
  })

  it('reads going home to the launcher', () => {
    for (const said of ['Go home.', 'Open the launcher.', 'Main menu.', 'Go to the menu']) {
      expect(parseNavCommand(said)).toEqual({ kind: 'home' })
    }
  })

  it('reads scrolling both ways', () => {
    expect(parseNavCommand('Scroll down.')).toEqual({ kind: 'scroll', delta: 1 })
    expect(parseNavCommand('Next page')).toEqual({ kind: 'scroll', delta: 1 })
    expect(parseNavCommand('Scroll up, please.')).toEqual({ kind: 'scroll', delta: -1 })
    expect(parseNavCommand('Previous page.')).toEqual({ kind: 'scroll', delta: -1 })
  })

  it('reads opening a tool', () => {
    expect(parseNavCommand('Open notes.')).toEqual({ kind: 'open', tool: 'Notes' })
    expect(parseNavCommand('Open my lists')).toEqual({ kind: 'open', tool: 'Notes' })
    expect(parseNavCommand('Open Jarvis.')).toEqual({ kind: 'open', tool: 'Jarvis' })
  })

  it('reads a new chat, with its mode', () => {
    expect(parseNavCommand('New chat.')).toEqual({ kind: 'newChat', mode: 'auto' })
    expect(parseNavCommand('Start a new interview chat')).toEqual({
      kind: 'newChat',
      mode: 'interview',
    })
    expect(parseNavCommand('New coding chat.')).toEqual({ kind: 'newChat', mode: 'coding' })
  })

  it('opens the Interview and Code entries, and a new chat in a language (G2-152)', () => {
    expect(parseNavCommand('Open interview.')).toEqual({ kind: 'open', tool: 'Interview' })
    expect(parseNavCommand('Open code.')).toEqual({ kind: 'open', tool: 'Code' })
    expect(parseNavCommand('New Python chat.')).toEqual({
      kind: 'newChat',
      mode: 'coding',
      language: 'Python',
    })
    expect(parseNavCommand('New TypeScript chat')).toEqual({
      kind: 'newChat',
      mode: 'coding',
      language: 'TypeScript',
    })
    expect(parseNavCommand('New C sharp chat')).toEqual({
      kind: 'newChat',
      mode: 'coding',
      language: 'C#',
    })
  })

  it('reads a new list and its name', () => {
    expect(parseNavCommand('New note called groceries.')).toEqual({
      kind: 'newList',
      name: 'Groceries',
    })
    expect(parseNavCommand('Create a list called weekend plans')).toEqual({
      kind: 'newList',
      name: 'Weekend Plans',
    })
  })

  it('leaves questions that only contain the words to the AI', () => {
    for (const said of [
      'How do I go back in git?',
      'What does scroll down mean in CSS?',
      'Can you explain how to open a file in Python?',
      'Tell me about yourself.',
      'Add eggs to groceries.',
    ]) {
      expect(parseNavCommand(said)).toBeNull()
    }
  })
})

describe('help (G2-183)', () => {
  it('understands asking for the gestures', () => {
    for (const said of ['Help', 'Hey Jarvis, help me.', 'What can I do?', 'Show me the controls']) {
      expect(parseNavCommand(said)).toEqual({ kind: 'help' })
    }
  })

  it('does not take a real question about help for the command', () => {
    expect(parseNavCommand('How do I help a friend who is stressed?')).toBeNull()
  })
})
