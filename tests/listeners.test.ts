import { describe, expect, it } from 'vitest'

describe('change listeners', () => {
  it('a listener that resubscribes while being called runs once, not forever', async () => {
    const { onCurrentScreenChange, setCurrentScreen } = await import('../src/core/currentScreen')
    let calls = 0
    let stop = () => {}
    const listen = () => {
      stop = onCurrentScreenChange(() => {
        calls += 1
        if (calls > 50) throw new Error('looping')
        // What a page does on redraw: drop its subscription, take a new one.
        stop()
        listen()
      })
    }
    listen()
    setCurrentScreen({ kind: 'menu' })
    expect(calls).toBe(1)
    stop()
  })
})
