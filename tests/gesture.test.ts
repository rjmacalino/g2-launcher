import { OsEventTypeList as E } from '@evenrealities/even_hub_sdk'
import { describe, expect, it } from 'vitest'
import {
  isAnyTap,
  isDoubleTap,
  isExit,
  isLifecycle,
  isListChoice,
  isListClick,
  isLongPress,
  isSingleTap,
  scrollDelta,
  typesOf,
} from '../src/shared/gesture'

// What a glasses event means (G2-175), as the shell reads it.

describe('typesOf', () => {
  it('reads an envelope with no type as a click: CLICK is 0 and dropped on the wire', () => {
    expect(typesOf({ sysEvent: {} })).toEqual({ sys: E.CLICK_EVENT, text: null, list: null })
  })

  it('never reads a click from an envelope that is not there', () => {
    expect(typesOf({ textEvent: { eventType: E.SCROLL_BOTTOM_EVENT } }).sys).toBeNull()
    expect(isSingleTap(typesOf({}))).toBe(false)
  })
})

describe('gestures', () => {
  it('a tap on the glasses is a single tap, not a list pick', () => {
    const t = typesOf({ sysEvent: {} })
    expect(isSingleTap(t)).toBe(true)
    expect(isListClick(t)).toBe(false)
  })

  it('a click on a list row picks the row and is not a single tap', () => {
    const t = typesOf({ listEvent: {} })
    expect(isListClick(t)).toBe(true)
    expect(isSingleTap(t)).toBe(false)
    expect(isAnyTap(t)).toBe(true)
  })

  it('a double-tap from any envelope is a double-tap, never a single tap', () => {
    for (const env of ['sysEvent', 'textEvent', 'listEvent'] as const) {
      const t = typesOf({ [env]: { eventType: E.DOUBLE_CLICK_EVENT } })
      expect(isDoubleTap(t)).toBe(true)
      expect(isSingleTap(t)).toBe(false)
    }
    expect(isListChoice(typesOf({ listEvent: { eventType: E.DOUBLE_CLICK_EVENT } }))).toBe(true)
  })

  it('long press, lifecycle and exit are read from the system envelope', () => {
    expect(isLongPress(typesOf({ sysEvent: { eventType: E.LONG_PRESS_EVENT } }))).toBe(true)
    expect(isLongPress(typesOf({ sysEvent: { eventType: E.LONG_PRESS_RELEASE_EVENT } }))).toBe(
      false,
    )
    expect(isLifecycle(typesOf({ sysEvent: { eventType: E.FOREGROUND_EXIT_EVENT } }))).toBe(true)
    expect(isExit(typesOf({ sysEvent: { eventType: E.ABNORMAL_EXIT_EVENT } }))).toBe(true)
  })

  it('a swipe past a text page edge scrolls one way or the other', () => {
    expect(scrollDelta(typesOf({ textEvent: { eventType: E.SCROLL_BOTTOM_EVENT } }))).toBe(1)
    expect(scrollDelta(typesOf({ textEvent: { eventType: E.SCROLL_TOP_EVENT } }))).toBe(-1)
    expect(scrollDelta(typesOf({ sysEvent: {} }))).toBeNull()
  })
})
