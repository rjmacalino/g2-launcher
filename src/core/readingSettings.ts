import { bridge, status } from '../platform/bridge'
import { setScreensPerPage } from '../features/chat/paging'
import { setUpStyle } from '../features/chat/viewer'
import {
  DEFAULT_READING_STYLE,
  parseReadingStyle,
  screensPerPage,
  type ReadingStyle,
} from '../shared/readingStyle'

// The reading style (G2-191, shared/readingStyle.ts), chosen on the phone.
// Read once at startup and applied at once when changed: the next answer
// shown, or the next page turn, follows it.
const STORAGE_KEY = 'jarvis.readingStyle'

let current: ReadingStyle = DEFAULT_READING_STYLE

function apply(style: ReadingStyle): void {
  current = style
  setScreensPerPage(screensPerPage(style))
  setUpStyle(style)
}

export function getReadingStyle(): ReadingStyle {
  return current
}

export async function loadReadingStyle(): Promise<void> {
  try {
    apply(parseReadingStyle(await bridge.getLocalStorage(STORAGE_KEY)))
  } catch {
    apply(DEFAULT_READING_STYLE)
  }
}

export async function setReadingStyle(style: ReadingStyle): Promise<boolean> {
  apply(style)
  const ok = await bridge.setLocalStorage(STORAGE_KEY, style)
  if (!ok) status('Failed to save the reading style')
  return ok
}
