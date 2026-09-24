import { defineConfig } from 'vitest/config'

// Pure logic only, no jsdom: nothing under test touches window/document, and
// this app has no component layer to render, so a DOM environment would
// only slow the run down for no benefit.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
})
