import { defineConfig } from 'vitest/config'

// Pure logic only, no jsdom: nothing under test touches window/document, and
// this app has no component layer to render, so a DOM environment would
// only slow the run down for no benefit.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Some tests dynamically import most of the app (launcher tools, the
    // providers): about 2 s alone, but past the default 5 s when every file
    // runs in parallel on this PC, which failed the gate at random.
    testTimeout: 20_000,
  },
})
