import { getForecastText, refresh } from '../weather-service'
import { setContent } from '../page'
import type { Tool } from './types'

// Plain text, not a list: nothing in a forecast is tappable, so there is no
// reason to pay for a rebuild (what a list refresh would need) when a text
// update via setContent does the same job in place - the same choice the old
// GPS tool made for its live coordinate updates.
//
// The actual data lives in weather-service.ts, refreshed on its own timer in
// the background regardless of which tool is on screen (the status bar needs
// it live on every page, not just this one). This tool just shows whatever
// that module already has, and nudges a refresh on open in case the
// background timer has not run recently.
export const weatherTool: Tool = {
  name: 'Weather',
  confirmOnExit: () => true,
  initialContent: getForecastText,
  onOpen: () => {
    refresh().then(() => setContent(getForecastText()))
  },
}
