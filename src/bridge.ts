import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'

// The companion page is the only surface that can show startup problems, since a
// failure here means nothing ever reaches the glasses.
const statusEl = document.getElementById('app')

export function status(line: string) {
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
