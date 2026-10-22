import { chatSessions, type ChatMessage, type ChatSession } from '../../features/chat/store'
import { askFromPhone } from '../../features/chat/assistant'
import { getCurrentScreen, onCurrentScreenChange } from '../../core/currentScreen'
import { NEW_CHAT, type AppContext, type Page, type Route } from '../app'
import { formatWhen, h, icon, toast } from '../dom'
import { splitAnswer } from '../../shared/answerBlocks'

// The Jarvis tab (G2-71): every conversation, readable in full, and a
// composer to ask Jarvis by typing - with or without the glasses. Asked
// here, a question appears on the glasses too when they show that
// conversation; asked on the glasses, it appears here as it is saved.

const SUGGESTIONS = [
  "What's on my shopping list?",
  'Set a timer for 10 minutes',
  'What did I talk about most recently?',
  'Add milk and eggs to my shopping list',
]

// A question typed here that has not been answered yet, kept across
// redraws while the request is out.
type Pending = {
  chatKey: string
  question: string
  answerSoFar: string
  done: boolean
  // For a command run from a new chat, which is not saved as a conversation.
  reply?: string
  error?: string
  noKey?: boolean
}
let pending: Pending | null = null

function onGlasses(sessionId: string): boolean {
  const screen = getCurrentScreen()
  if (screen.kind !== 'tool' || screen.name !== 'Jarvis') return false
  const detail = screen.detail as { depth?: string; sessionId?: string } | undefined
  return detail?.depth === 'conversation' && detail.sessionId === sessionId
}

function sessionRow(ctx: AppContext, session: ChatSession): HTMLElement {
  const last = session.messages[session.messages.length - 1]
  return h(
    'li',
    {},
    h(
      'button',
      { class: 'row', onclick: () => ctx.navigate({ tab: 'jarvis', chatId: session.id }) },
      h(
        'div',
        { class: 'row-main' },
        h(
          'div',
          { class: 'row-title' },
          h('span', { class: 'text' }, session.title || '(untitled)'),
          onGlasses(session.id) ? h('span', { class: 'chip accent' }, 'On glasses') : null,
        ),
        h(
          'div',
          { class: 'row-sub' },
          `${formatWhen(session.updatedAt)}${last ? ` - ${last.text.replace(/\s+/g, ' ')}` : ''}`,
        ),
      ),
      icon('chevron', 'chevron'),
    ),
  )
}

function listPage(ctx: AppContext): Page {
  const sessions = [...(chatSessions.peek() ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)
  if (chatSessions.peek() === null) void chatSessions.readAll().then(() => ctx.refresh())
  const body = h(
    'div',
    {},
    h(
      'button',
      {
        class: 'button primary block',
        onclick: () => ctx.navigate({ tab: 'jarvis', chatId: NEW_CHAT }),
      },
      icon('plus'),
      'New chat',
    ),
    sessions.length === 0
      ? h(
          'div',
          { class: 'empty' },
          icon('jarvis'),
          h('h2', {}, 'No conversations yet'),
          h('div', {}, 'Type a question here, or say "Hey Jarvis" to the glasses from any screen.'),
        )
      : [
          h('div', { class: 'section-label' }, 'Conversations'),
          h(
            'ul',
            { class: 'list' },
            sessions.map(s => sessionRow(ctx, s)),
          ),
        ],
  )
  const stopChat = chatSessions.onChange(() => ctx.refresh())
  const stopScreen = onCurrentScreenChange(() => ctx.refresh())
  return {
    title: 'Jarvis',
    body,
    cleanup: () => {
      stopChat()
      stopScreen()
    },
  }
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // The host WebView may not allow the clipboard API; the older way.
    const area = h('textarea', { style: 'position: fixed; opacity: 0' }) as HTMLTextAreaElement
    area.value = text
    document.body.append(area)
    area.select()
    document.execCommand('copy')
    area.remove()
  }
  toast('Copied')
}

// An answer with its code shown as code (G2-72): monospace, scrolling
// sideways instead of wrapping, with a copy button.
function answerBody(text: string): (HTMLElement | string)[] {
  const blocks = splitAnswer(text)
  if (blocks.length === 1 && blocks[0].kind === 'text') return [text]
  return blocks.map(block =>
    block.kind === 'code'
      ? h(
          'div',
          { class: 'code-block' },
          h('pre', {}, block.text),
          h('button', { class: 'copy', onclick: () => void copy(block.text) }, 'Copy'),
        )
      : h('div', { class: 'prose' }, block.text),
  )
}

// Where a searched answer came from (G2-76): page titles, each opening
// the page.
function sources(message: ChatMessage): HTMLElement | null {
  if (!message.sources || message.sources.length === 0) return null
  return h(
    'div',
    { class: 'sources' },
    'Sources: ',
    ...message.sources.flatMap((source, i) => [
      i > 0 ? ' - ' : '',
      h('a', { href: source.url, target: '_blank', rel: 'noopener' }, source.title),
    ]),
  )
}

function bubble(message: ChatMessage): HTMLElement[] {
  return [
    h(
      'div',
      { class: `bubble ${message.role}${message.role === 'model' ? ' rich' : ''}` },
      ...(message.role === 'model' ? answerBody(message.text) : [message.text]),
      sources(message),
    ),
    h(
      'div',
      { class: `bubble-meta ${message.role}` },
      message.model
        ? `${message.model} - ${formatWhen(message.timestamp)}`
        : formatWhen(message.timestamp),
    ),
  ]
}

function typingDots(): HTMLElement {
  return h('span', { class: 'typing', 'aria-label': 'Jarvis is thinking' }, h('i'), h('i'), h('i'))
}

function chatPage(ctx: AppContext, chatId: string): Page {
  const isNew = chatId === NEW_CHAT
  const session = isNew ? undefined : (chatSessions.peek() ?? []).find(s => s.id === chatId)
  if (!isNew && !session) {
    if (chatSessions.peek() === null) void chatSessions.readAll().then(() => ctx.refresh())
    else queueMicrotask(() => ctx.navigate({ tab: 'jarvis' }, { replace: true }))
  }
  const mine = pending && pending.chatKey === chatId ? pending : null
  const messages = session?.messages ?? []

  const list = h('div', { class: 'messages' }, messages.flatMap(bubble))
  let answerBubble: HTMLElement | null = null
  if (mine) {
    const last = messages[messages.length - 1]
    if (!(last && last.role === 'user' && last.text === mine.question)) {
      list.append(h('div', { class: 'bubble user' }, mine.question))
    }
    if (mine.noKey) {
      list.append(
        h(
          'div',
          { class: 'bubble error' },
          'Jarvis needs an AI key to answer questions. ',
          h(
            'button',
            { class: 'button', onclick: () => ctx.navigate({ tab: 'settings' }) },
            'Add one in Settings',
          ),
        ),
      )
    } else if (mine.error) {
      list.append(h('div', { class: 'bubble error' }, mine.error))
    } else if (mine.reply) {
      list.append(h('div', { class: 'bubble model' }, mine.reply))
    } else if (!mine.done) {
      answerBubble = h('div', { class: 'bubble model' }, mine.answerSoFar || typingDots())
      list.append(answerBubble)
    }
  }

  const body = h('div', {}, list)
  if (isNew && messages.length === 0 && !mine) {
    body.prepend(
      h(
        'div',
        { class: 'hero' },
        h('h2', {}, 'Ask Jarvis'),
        h(
          'p',
          {},
          'Questions, or things to do - add to a list, start a timer. The answer shows here and on the glasses.',
        ),
        h(
          'div',
          { class: 'suggestions' },
          SUGGESTIONS.map(text =>
            h('button', { class: 'suggestion', onclick: () => void send(text) }, text),
          ),
        ),
      ),
    )
  }

  const input = h('textarea', {
    rows: '1',
    placeholder: 'Ask Jarvis...',
    'aria-label': 'Message Jarvis',
  }) as HTMLTextAreaElement
  const sendButton = h(
    'button',
    { class: 'send', 'aria-label': 'Send', disabled: !!(mine && !mine.done) },
    icon('send'),
  ) as HTMLButtonElement

  async function send(text: string) {
    const question = text.trim()
    if (!question || (pending && !pending.done)) return
    input.value = ''
    const job: Pending = { chatKey: chatId, question, answerSoFar: '', done: false }
    pending = job
    ctx.refresh()
    const result = await askFromPhone(question, isNew ? null : chatId, {
      onText: soFar => {
        job.answerSoFar = soFar
        if (answerBubble && pending === job) {
          answerBubble.textContent = soFar
          answerBubble.scrollIntoView({ block: 'end' })
        }
      },
    })
    if (pending !== job) return
    switch (result.kind) {
      case 'answered':
        pending = null
        if (isNew) ctx.navigate({ tab: 'jarvis', chatId: result.session.id }, { replace: true })
        else ctx.refresh()
        return
      case 'command':
        if (result.session) {
          pending = null
          ctx.refresh()
        } else {
          job.reply = result.reply
          job.done = true
          ctx.refresh()
        }
        return
      case 'no-key':
        job.noKey = true
        job.done = true
        ctx.refresh()
        return
      case 'error':
        job.error = result.message
        job.done = true
        if (isNew) {
          pending = { ...job, chatKey: result.session.id }
          ctx.navigate({ tab: 'jarvis', chatId: result.session.id }, { replace: true })
        } else {
          ctx.refresh()
        }
    }
  }

  input.addEventListener('input', () => {
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`
  })
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send(input.value)
    }
  })
  sendButton.addEventListener('click', () => void send(input.value))

  const actions: HTMLElement[] = []
  if (session) {
    actions.push(
      h(
        'button',
        {
          class: 'icon-button',
          'aria-label': 'Delete conversation',
          onclick: async () => {
            if (!window.confirm(`Delete "${session.title}"? This cannot be undone.`)) return
            await chatSessions.remove(session.id)
            toast('Conversation deleted')
            ctx.navigate({ tab: 'jarvis' }, { replace: true })
          },
        },
        icon('trash'),
      ),
    )
  }

  // A finished command or error from a new chat stays on screen until the
  // person leaves; after that it is gone, like the glasses' own.
  const stopChat = chatSessions.onChange(() => {
    if (!pending || pending.done) ctx.refresh()
  })
  return {
    title: session?.title ?? 'New chat',
    back: { tab: 'jarvis' },
    actions,
    body,
    footer: h('div', { class: 'composer' }, input, sendButton),
    scrollToEnd: true,
    cleanup: leaving => {
      stopChat()
      if (leaving && pending?.done && pending.chatKey === chatId) pending = null
    },
  }
}

export function jarvisView(ctx: AppContext, route: Route): Page {
  if (route.tab === 'jarvis' && route.chatId) return chatPage(ctx, route.chatId)
  return listPage(ctx)
}
