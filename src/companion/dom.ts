// A tiny element builder for the phone app (G2-71). No framework: every
// list here is a wearer's own notes and chats, not a feed, so rebuilding a
// view's elements on change is cheap - and text is always set as text,
// never parsed as HTML, so nothing a model or a person typed can inject
// markup.

type Child = Node | string | null | undefined | false
type Attrs = Record<string, string | number | boolean | EventListener | undefined>

export function h(tag: string, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElement {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value)
    } else if (key === 'value' && 'value' in el) {
      ;(el as HTMLInputElement).value = String(value)
    } else {
      el.setAttribute(key, value === true ? '' : String(value))
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue
    el.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return el
}

// Simple stroked icons, 24 x 24, drawn for this app.
const ICONS: Record<string, string> = {
  jarvis:
    '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  live: '<path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 7v10M21 12h0"/>',
  notes:
    '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 9l1.5 1.5L12 8M8 15l1.5 1.5L12 14M14 9h2M14 15h2"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  chevron: '<path d="M9 18l6-6-6-6"/>',
  send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/>',
  glasses:
    '<circle cx="6.5" cy="14" r="3.5"/><circle cx="17.5" cy="14" r="3.5"/><path d="M10 14h4M3 14l1-6h3M21 14l-1-6h-3"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
}

export function icon(name: keyof typeof ICONS | string, cls = ''): SVGSVGElement {
  const wrap = document.createElement('span')
  wrap.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${cls ? ` class="${cls}"` : ''}>${ICONS[name] ?? ''}</svg>`
  return wrap.firstElementChild as SVGSVGElement
}

// "Just now", "5 min ago", "3:40 pm", "Mon 3:40 pm" or a date.
export function formatWhen(timestamp: number, now: number = Date.now()): string {
  const diff = now - timestamp
  if (diff < 60_000) return 'Just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`
  const date = new Date(timestamp)
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const today = new Date(now)
  if (date.toDateString() === today.toDateString()) return time
  if (diff < 6 * 86_400_000) {
    return `${date.toLocaleDateString([], { weekday: 'short' })} ${time}`
  }
  return date.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  return `${minutes}:${String(total % 60).padStart(2, '0')}`
}

let toastTimer: ReturnType<typeof setTimeout> | null = null

export function toast(message: string): void {
  document.querySelector('.toast')?.remove()
  if (toastTimer !== null) clearTimeout(toastTimer)
  const el = h('div', { class: 'toast', role: 'status' }, message)
  document.body.append(el)
  toastTimer = setTimeout(() => el.remove(), 2500)
}

// Whether the person is in the middle of typing something on the page -
// the glasses moving must not throw that away (see main.ts).
export function isTyping(): boolean {
  const el = document.activeElement
  return (
    (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value.trim() !== ''
  )
}
