import { describe, expect, it } from 'vitest'
import { answerHeader, modeModelLine } from '../src/shared/answerHeader'

// The two lines above every answer (G2-200).

describe('answerHeader', () => {
  it('names the mode and the model on one line', () => {
    expect(modeModelLine('Interview - DeepSeek Flash')).toBe(
      'Mode: Interview - Model: DeepSeek Flash',
    )
    expect(modeModelLine('Code (Python) - DeepSeek Flash')).toBe(
      'Mode: Code (Python) - Model: DeepSeek Flash',
    )
  })

  it('has only the model for a Jarvis chat, which has no mode', () => {
    expect(modeModelLine('DeepSeek Flash')).toBe('Model: DeepSeek Flash')
  })

  it('puts the question first, as Q:, with no divider', () => {
    expect(answerHeader('What is a closure?', 'Interview - DeepSeek Flash')).toBe(
      'Q: What is a closure?\nMode: Interview - Model: DeepSeek Flash',
    )
    expect(answerHeader('What is a closure?', null)).toBe('Q: What is a closure?')
  })
})
