import { status } from '../platform/bridge'
import type { Route } from './app'
import { chatSessions } from '../features/chat/store'
import { devAsk } from '../features/chat/tool'
import { probeLongText } from '../platform/textProbe'

// The page half of vite.config.ts's dev-only remote control (G2-71):
// lets a test script tap and type on the phone page the way a person
// would, so phone -> glasses sync can be checked in the simulator. Loaded
// only under the dev server (see main.ts); results go to the status log,
// which the simulator's console API can read.

export type DevCommand =
  | { action: 'navigate'; route: Route }
  | { action: 'click'; selector: string; index?: number; text?: string }
  | { action: 'type'; selector: string; text: string; enter?: boolean }
  | { action: 'read'; selector: string }
  // Saves a made-up conversation, to see long answers without an AI call.
  | { action: 'seedChat'; question: string; answer: string }
  // Asks a question on the glasses as if spoken (needs Jarvis open there).
  | { action: 'glassesAsk'; text: string }
  // The long-text test of Settings > Diagnostics, from a script.
  | { action: 'probeText'; kind: 'single' | 'append' }

function find(selector: string, index = 0, text?: string): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>(selector)]
  const matches = text ? all.filter(el => el.textContent?.includes(text)) : all
  return matches[index] ?? null
}

export function runDevCommand(command: DevCommand, navigate: (route: Route) => void): void {
  switch (command.action) {
    case 'navigate':
      navigate(command.route)
      status(`dev: navigated to ${JSON.stringify(command.route)}`)
      return
    case 'click': {
      const el = find(command.selector, command.index, command.text)
      if (!el) return status(`dev: nothing matches ${command.selector}`)
      el.click()
      status(`dev: clicked ${command.selector}${command.text ? ` "${command.text}"` : ''}`)
      return
    }
    case 'type': {
      const el = find(command.selector)
      const field =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      if (!field) {
        return status(`dev: no field matches ${command.selector}`)
      }
      el.focus()
      el.value = command.text
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      if (command.enter) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      }
      status(`dev: typed into ${command.selector}`)
      return
    }
    case 'probeText':
      void probeLongText(command.kind)
      return
    case 'glassesAsk':
      void devAsk(command.text).then(() => status('dev: asked on the glasses'))
      return
    case 'seedChat': {
      const session = chatSessions.newSession({
        role: 'user',
        text: command.question,
        timestamp: Date.now(),
      })
      session.messages.push({ role: 'model', text: command.answer, timestamp: Date.now() })
      void chatSessions.save(session).then(() => {
        navigate({ tab: 'jarvis', chatId: session.id })
        status(`dev: seeded chat ${session.id}`)
      })
      return
    }
    case 'read': {
      const texts = [...document.querySelectorAll<HTMLElement>(command.selector)].map(el =>
        (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
      )
      status(`dev: read ${command.selector} = ${JSON.stringify(texts)}`)
    }
  }
}
