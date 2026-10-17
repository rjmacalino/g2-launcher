import { defineConfig, type Plugin } from 'vite'

// Dev-only remote control for the phone page (G2-71), so the simulator can
// test the phone side too: the simulator's automation API can tap the
// glasses but not the phone page. POST a JSON command to
// /__dev/companion (from this machine only) and it reaches
// src/companion/devControl.ts over Vite's own live-reload connection.
// 'serve' only - it does not exist in a build, and the client half is
// behind import.meta.hot, which is undefined in a build.
function companionDevControl(): Plugin {
  const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
  return {
    name: 'companion-dev-control',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__dev/companion', (req, res) => {
        if (req.method !== 'POST' || !loopback.has(req.socket.remoteAddress ?? '')) {
          res.statusCode = 403
          res.end()
          return
        }
        let body = ''
        req.on('data', chunk => (body += chunk))
        req.on('end', () => {
          try {
            server.ws.send({ type: 'custom', event: 'companion:dev', data: JSON.parse(body) })
            res.end('sent')
          } catch {
            res.statusCode = 400
            res.end('bad json')
          }
        })
      })
    },
  }
}

export default defineConfig({
  server: { host: true, port: 5173 },
  build: { target: 'esnext' },
  // Vite bundles workers as a single classic script ('iife') by default,
  // which cannot hold the separate chunk Transformers.js is split into
  // (core/whisperEngine.ts loads it with a dynamic import). 'es' builds the
  // worker as a module instead, matching the { type: 'module' } that
  // core/whisper.ts starts it with.
  worker: { format: 'es' },
  plugins: [companionDevControl()],
})
