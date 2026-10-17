import { defineConfig } from 'vite'

export default defineConfig({
  server: { host: true, port: 5173 },
  build: { target: 'esnext' },
  // Vite bundles workers as a single classic script ('iife') by default,
  // which cannot hold the separate chunk Transformers.js is split into
  // (core/whisperEngine.ts loads it with a dynamic import). 'es' builds the
  // worker as a module instead, matching the { type: 'module' } that
  // core/whisper.ts starts it with.
  worker: { format: 'es' },
})
