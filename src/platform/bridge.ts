import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'

// The SDK logs every event it receives - "[EvenAppBridge] EvenHub event:"
// plus the whole event - with no option to turn that off (read from its
// dist, which is obfuscated). With "Hey Jarvis" holding the mic open, that
// is ten 3,200-sample audio events a second, every second the app is open,
// and on Android each console message is also handed to the system log.
// Only those audio-event lines are dropped; every other log still prints.
const SDK_EVENT_LABEL = '[EvenAppBridge] EvenHub event'

function isAudioEventLog(args: unknown[]): boolean {
  if (typeof args[0] !== 'string' || !args[0].startsWith(SDK_EVENT_LABEL)) return false
  const rest = args.length > 1 ? args[1] : args[0].slice(SDK_EVENT_LABEL.length)
  if (typeof rest === 'string') return rest.slice(0, 40).includes('audioPcm')
  if (!rest || typeof rest !== 'object') return false
  const event = rest as { jsonData?: { audioPcm?: unknown }; audioPcm?: unknown }
  return event.audioPcm !== undefined || event.jsonData?.audioPcm !== undefined
}

// eslint-disable-next-line no-console
const sdkLog = console.log.bind(console)
// eslint-disable-next-line no-console
console.log = (...args: unknown[]) => {
  if (!isAudioEventLog(args)) sdkLog(...args)
}

// Diagnostics only, a thin strip separate from the companion UI in #companion.
// Startup problems, and nothing else, need somewhere to show up when there is
// no real UI to display them in yet.
const statusEl = document.getElementById('status')

export function status(line: string) {
  // The one sanctioned console.log in this codebase: every other diagnostic
  // funnels through this function, so an eslint no-console rule elsewhere
  // catches code that bypassed it instead of allowing console.log everywhere.
  // eslint-disable-next-line no-console
  console.log(line)
  if (statusEl) statusEl.textContent = line
}

window.addEventListener('unhandledrejection', event => {
  status(`Startup failed: ${event.reason}`)
})
window.addEventListener('error', event => {
  status(`Error: ${event.message}`)
})

status('Waiting for the Even app bridge...')

// A hung bridge and a crashed bridge look identical on the glasses (blank screen,
// no event container), so force the hang to announce itself.
//
// Top-level await in a module: every importer waits for this to settle before its
// own body runs, so `bridge` is always a live bridge by the time anything uses it.
// That is what lets tool modules import it directly instead of having it threaded
// through an init function.
export const bridge = await Promise.race([
  waitForEvenAppBridge(),
  new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error('bridge did not arrive within 10s')), 10000)
  }),
])

status('Bridge ready, creating page...')
