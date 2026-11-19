import { OsEventTypeList } from '@evenrealities/even_hub_sdk'

// What a glasses event means as a gesture (split out of app/main.ts in
// G2-175 so it can be tested). An event carries up to three envelopes:
//   - sysEvent  -> taps, double-taps, long press, lifecycle (foreground, exit)
//   - textEvent -> scroll gestures and clicks on text containers
//   - listEvent -> list item events (highlight, click)
// The shell asks these questions in its own order (see app/main.ts). Pure.

export type EventTypes = {
  sys: OsEventTypeList | null
  text: OsEventTypeList | null
  list: OsEventTypeList | null
}

// CLICK_EVENT is 0, and protobuf omits zero-value fields on the wire, so a
// single tap arrives as an envelope whose `eventType` is `undefined`. The
// default has to be resolved INSIDE the envelope check: reading
// `event.sysEvent?.eventType ?? CLICK_EVENT` would read CLICK on events that
// carry no sysEvent at all, so every scroll, exit and audio frame would fire
// the tap handler.
export function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

export function typesOf(event: {
  sysEvent?: { eventType?: OsEventTypeList }
  textEvent?: { eventType?: OsEventTypeList }
  listEvent?: { eventType?: OsEventTypeList }
}): EventTypes {
  return {
    sys: eventTypeOf(event.sysEvent),
    text: eventTypeOf(event.textEvent),
    list: eventTypeOf(event.listEvent),
  }
}

const any = (t: EventTypes, type: OsEventTypeList) =>
  t.sys === type || t.text === type || t.list === type

export function isDoubleTap(t: EventTypes): boolean {
  return any(t, OsEventTypeList.DOUBLE_CLICK_EVENT)
}

// Any tap or double-tap, from any envelope (dismissing an alert).
export function isAnyTap(t: EventTypes): boolean {
  return isDoubleTap(t) || any(t, OsEventTypeList.CLICK_EVENT)
}

// A single tap on the glasses or a text container, not a list row: a list
// click picks the row instead.
export function isSingleTap(t: EventTypes): boolean {
  return (
    !isDoubleTap(t) &&
    (t.sys === OsEventTypeList.CLICK_EVENT || t.text === OsEventTypeList.CLICK_EVENT)
  )
}

// A list row picked (click) - or, on the leave prompt, confirmed by either.
export function isListClick(t: EventTypes): boolean {
  return t.list === OsEventTypeList.CLICK_EVENT
}

export function isListChoice(t: EventTypes): boolean {
  return isListClick(t) || t.list === OsEventTypeList.DOUBLE_CLICK_EVENT
}

export function isLongPress(t: EventTypes): boolean {
  return t.sys === OsEventTypeList.LONG_PRESS_EVENT
}

export function isForegroundEnter(t: EventTypes): boolean {
  return t.sys === OsEventTypeList.FOREGROUND_ENTER_EVENT
}

export function isForegroundExit(t: EventTypes): boolean {
  return t.sys === OsEventTypeList.FOREGROUND_EXIT_EVENT
}

export function isLifecycle(t: EventTypes): boolean {
  return isForegroundEnter(t) || isForegroundExit(t)
}

export function isExit(t: EventTypes): boolean {
  return (
    t.sys === OsEventTypeList.SYSTEM_EXIT_EVENT || t.sys === OsEventTypeList.ABNORMAL_EXIT_EVENT
  )
}

// A swipe past a text page's edge: 1 at the bottom, -1 at the top.
export function scrollDelta(t: EventTypes): 1 | -1 | null {
  if (t.text === OsEventTypeList.SCROLL_BOTTOM_EVENT) return 1
  if (t.text === OsEventTypeList.SCROLL_TOP_EVENT) return -1
  return null
}
