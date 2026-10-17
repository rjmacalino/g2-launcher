import { describe, expect, it } from 'vitest'
import { parseQuickQuestion } from '../src/shared/quickQuestions'

describe('parseQuickQuestion', () => {
  it('recognises the time, however Whisper punctuates it', () => {
    expect(parseQuickQuestion('What time is it?')).toEqual({ kind: 'time' })
    expect(parseQuickQuestion("What's the time.")).toEqual({ kind: 'time' })
    expect(parseQuickQuestion('Hey Jarvis, what time is it now?')).toEqual({ kind: 'time' })
  })

  it('recognises the date', () => {
    expect(parseQuickQuestion("What's today's date?")).toEqual({ kind: 'date' })
    expect(parseQuickQuestion('What day is it today?')).toEqual({ kind: 'date' })
  })

  it('recognises weather now, today and tomorrow', () => {
    expect(parseQuickQuestion("What's the weather like?")).toEqual({ kind: 'weather', when: 'now' })
    expect(parseQuickQuestion('How is the weather today?')).toEqual({
      kind: 'weather',
      when: 'today',
    })
    expect(parseQuickQuestion('Weather tomorrow')).toEqual({ kind: 'weather', when: 'tomorrow' })
    expect(parseQuickQuestion('Will it rain tomorrow?')).toEqual({ kind: 'rain', when: 'tomorrow' })
  })

  it('leaves anything longer or different to the AI', () => {
    expect(parseQuickQuestion('What time does the movie start?')).toBeNull()
    expect(parseQuickQuestion("What's the weather in Tokyo?")).toBeNull()
    expect(parseQuickQuestion('What day is Christmas this year?')).toBeNull()
    expect(parseQuickQuestion('Tell me about time travel')).toBeNull()
  })
})
