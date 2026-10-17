import {
  askCueNow,
  getLiveState,
  onLiveChange,
  togglePause,
  type LiveLine,
} from '../../features/live/tool'
import { getPrepNotes } from '../../features/live/settings'
import { chatSessions } from '../../features/chat/store'
import type { AppContext, Page } from '../app'
import { clock, formatWhen, h, icon } from '../dom'
import { isWingmanTitle } from '../../features/live/summary'

// The Wingman tab (G2-71). Live listens through the glasses' own
// microphone - the Even app does not let a plugin use the phone's (see
// docs/roadmap.md, D1) - so it is started and ended here but runs on the
// glasses. While it runs, this page is the full view: every line, every
// cue, the level, while the glasses show the newest few lines.

function who(speaker: string): string {
  if (speaker === 'self') return 'You'
  if (speaker === 'other') return 'Them'
  return ''
}

function line(l: LiveLine): HTMLElement {
  const name = who(l.speaker)
  return h(
    'div',
    { class: `line ${l.speaker}` },
    name ? h('span', { class: 'who' }, name) : null,
    l.text,
  )
}

function idlePage(ctx: AppContext): Page {
  const connected = ctx.glassesConnected()
  const notes = h('div', { class: 'caption' }, 'Loading prep notes...')
  void getPrepNotes().then(text => {
    notes.textContent = text || 'None yet - add some in Settings before a conversation.'
  })
  const past = [...(chatSessions.peek() ?? [])]
    .filter(s => isWingmanTitle(s.title))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 10)

  const body = h(
    'div',
    {},
    h(
      'div',
      { class: 'hero' },
      h('h2', {}, 'Wingman'),
      h(
        'p',
        {},
        'Listens to the conversation you are having, keeps a transcript, and flashes a short cue on the glasses when one would help - the answer to a question you were just asked, a fact you need. When you end it, Jarvis saves a summary you can ask about later.',
      ),
      h(
        'button',
        {
          class: 'button primary block',
          disabled: !connected,
          onclick: () => ctx.requestGlasses({ kind: 'tool', name: 'Wingman' }),
        },
        icon('live'),
        'Start listening',
      ),
      connected
        ? null
        : h(
            'p',
            { class: 'caption', style: 'margin: 12px 0 0' },
            'Connect your glasses to start: Live listens through their microphone.',
          ),
    ),
    h('div', { class: 'section-label' }, 'Prep notes for the next conversation'),
    h(
      'button',
      { class: 'row', onclick: () => ctx.navigate({ tab: 'settings' }) },
      h('div', { class: 'row-main' }, notes),
      icon('chevron', 'chevron'),
    ),
    past.length > 0
      ? [
          h('div', { class: 'section-label' }, 'Past conversations'),
          h(
            'ul',
            { class: 'list' },
            past.map(s =>
              h(
                'li',
                {},
                h(
                  'button',
                  { class: 'row', onclick: () => ctx.navigate({ tab: 'jarvis', chatId: s.id }) },
                  h(
                    'div',
                    { class: 'row-main' },
                    h('div', { class: 'row-title' }, h('span', { class: 'text' }, s.title)),
                    h('div', { class: 'row-sub' }, formatWhen(s.updatedAt)),
                  ),
                  icon('chevron', 'chevron'),
                ),
              ),
            ),
          ),
        ]
      : null,
  )
  const stop = onLiveChange(() => {
    if (getLiveState().running) ctx.refresh()
  })
  return { title: 'Wingman', body, cleanup: () => stop() }
}

function runningPage(ctx: AppContext): Page {
  const clockEl = h('div', { class: 'live-clock' })
  const stateEl = h('div', { class: 'live-state' })
  const meterFill = h('i')
  const meter = h('div', { class: 'meter' }, meterFill)
  const cueCard = h('div', { class: 'cue-card' })
  const transcript = h('div', { class: 'transcript' })
  const pauseButton = h('button', { class: 'button', onclick: () => void togglePause() }, 'Pause')
  let shownLines = 0

  function update() {
    const state = getLiveState()
    if (!state.running) {
      ctx.refresh()
      return
    }
    clockEl.textContent = clock(Date.now() - state.startedAt)
    pauseButton.textContent = state.paused ? 'Resume' : 'Pause'
    stateEl.textContent = state.paused
      ? 'Paused - not listening'
      : state.hearing === 'speech'
        ? 'Hearing speech'
        : state.hearing === 'writing'
          ? 'Writing it down...'
          : 'Quiet'
    meter.className = `meter${state.hearing === 'speech' ? ' speech' : ''}`
    meterFill.style.width = `${Math.min(100, Math.max(4, (state.levelRatio / 8) * 100))}%`

    cueCard.replaceChildren()
    if (state.cue) {
      cueCard.className = 'cue-card'
      cueCard.append(
        h('div', { class: 'label' }, `Cue - ${formatWhen(state.cue.at)}`),
        h('div', { class: 'cue' }, state.cue.text),
      )
    } else {
      cueCard.className = 'cue-card empty-cue'
      cueCard.append(
        h('div', { class: 'label' }, 'Cue'),
        h('div', {}, state.cueNote || 'Nothing to add yet - Jarvis speaks up when it can help.'),
      )
    }

    if (state.lines.length !== shownLines) {
      const nearEnd =
        transcript.parentElement !== null &&
        window.innerHeight - transcript.getBoundingClientRect().bottom > -120
      transcript.append(...state.lines.slice(shownLines).map(line))
      shownLines = state.lines.length
      if (nearEnd) transcript.lastElementChild?.scrollIntoView({ block: 'end' })
    }
  }

  const body = h(
    'div',
    {},
    h(
      'div',
      { class: 'live-status' },
      h('div', { style: 'flex: 1' }, clockEl, stateEl, meter),
      pauseButton,
      h(
        'button',
        {
          class: 'button danger',
          onclick: () => ctx.requestGlasses({ kind: 'menu' }),
        },
        'End',
      ),
    ),
    cueCard,
    h(
      'div',
      { class: 'button-row' },
      h('button', { class: 'button primary block', onclick: () => askCueNow() }, 'What do I say?'),
    ),
    h('div', { class: 'section-label' }, 'Transcript'),
    transcript,
  )
  update()
  const stop = onLiveChange(update)
  return { title: 'Wingman', body, scrollToEnd: true, cleanup: () => stop() }
}

export function liveView(ctx: AppContext): Page {
  return getLiveState().running ? runningPage(ctx) : idlePage(ctx)
}
