import { bridge, onStatus, recentStatus } from '../../platform/bridge'
import { ABOUT_ME_MAX_CHARS, getAboutMe, setAboutMe } from '../../core/geminiSettings'
import {
  PROVIDERS,
  getProvider,
  getProviderKey,
  getProviderModel,
  providerInfo,
  setProvider,
  setProviderKey,
  setProviderModel,
  type Provider,
} from '../../core/llmSettings'
import { isWakeWordEnabled, setWakeWordEnabled } from '../../core/wakeSettings'
import { isWakeListening, wakeDescription } from '../../core/wakeListener'
import { getPrepNotes, setPrepNotes, PREP_NOTES_MAX_CHARS } from '../../features/live/settings'
import type { AppContext, Page } from '../app'
import { h, icon, toast } from '../dom'

// The Settings tab (G2-71). Everything here lives only on this phone - the
// AI keys included, never in the app's code (see core/llmSettings.ts).

function card(...children: (HTMLElement | null)[]): HTMLElement {
  return h('div', { class: 'card' }, ...children)
}

function label(text: string): HTMLElement {
  return h('div', { class: 'section-label' }, text)
}

function glassesCard(ctx: AppContext): HTMLElement {
  const stats = h('div', { class: 'stat-grid' })
  const state = h('div', { class: 'caption' }, 'Checking...')
  void bridge.getDeviceInfo().then(
    info => {
      const s = info?.status
      state.textContent = ctx.glassesConnected()
        ? `${info?.model ?? 'Glasses'} connected`
        : 'Not connected - Jarvis, Notes and Settings still work here.'
      stats.replaceChildren(
        h(
          'div',
          { class: 'stat' },
          h('b', {}, s?.batteryLevel !== undefined ? `${s.batteryLevel}%` : '-'),
          h('span', {}, 'Battery'),
        ),
        h(
          'div',
          { class: 'stat' },
          h('b', {}, s?.isWearing ? 'Yes' : s?.isWearing === false ? 'No' : '-'),
          h('span', {}, 'Wearing'),
        ),
        h(
          'div',
          { class: 'stat' },
          h('b', {}, s?.isCharging ? 'Yes' : s?.isCharging === false ? 'No' : '-'),
          h('span', {}, 'Charging'),
        ),
      )
    },
    () => {
      state.textContent = 'Could not read the glasses.'
    },
  )

  const wakeSwitch = h('button', { class: 'switch', role: 'switch', 'aria-label': 'Hey Jarvis' })
  const wakeCaption = h('div', { class: 'caption' })
  const paint = (on: boolean) => {
    wakeSwitch.className = `switch${on ? ' on' : ''}`
    wakeSwitch.setAttribute('aria-checked', String(on))
    wakeCaption.textContent = on
      ? isWakeListening()
        ? `Listening now (${wakeDescription()}).`
        : 'On - starts when the glasses are connected.'
      : 'Off. Long-press on the glasses still reaches Jarvis.'
  }
  void isWakeWordEnabled().then(paint)
  wakeSwitch.addEventListener('click', async () => {
    const on = !wakeSwitch.classList.contains('on')
    paint(on)
    await setWakeWordEnabled(on)
    setTimeout(() => paint(on), 800)
  })

  return card(
    h(
      'div',
      { class: 'switch-row' },
      h('div', { class: 'row-main' }, h('h2', {}, 'Glasses'), state),
      icon('glasses'),
    ),
    stats,
    h('div', { style: 'height: 16px' }),
    h(
      'div',
      { class: 'switch-row' },
      h(
        'div',
        { class: 'row-main' },
        h('div', { style: 'font-weight: 500' }, '"Hey Jarvis"'),
        wakeCaption,
      ),
      wakeSwitch,
    ),
    h(
      'p',
      { class: 'caption', style: 'margin: 8px 0 0' },
      'Listens for its name on the glasses microphone while the app is open. The listening happens on this phone; nothing is stored or sent until you speak to Jarvis.',
    ),
  )
}

function aiCard(ctx: AppContext): HTMLElement {
  const body = h('div', {}, h('div', { class: 'caption' }, 'Loading...'))
  void (async () => {
    const provider = await getProvider()
    const info = providerInfo(provider)
    const [key, model] = await Promise.all([getProviderKey(provider), getProviderModel(provider)])

    const segmented = h(
      'div',
      { class: 'segmented', role: 'tablist' },
      PROVIDERS.map(p =>
        h(
          'button',
          {
            class: p.id === provider ? 'on' : '',
            role: 'tab',
            'aria-selected': String(p.id === provider),
            onclick: async () => {
              if (p.id === provider) return
              await setProvider(p.id as Provider)
              toast(`Jarvis now uses ${p.label}`)
              ctx.refresh()
            },
          },
          p.label,
        ),
      ),
    )
    const modelSelect = h(
      'select',
      { class: 'field', 'aria-label': 'Model' },
      info.models.map(m => h('option', { value: m, selected: m === model }, m)),
    ) as HTMLSelectElement
    modelSelect.addEventListener('change', async () => {
      await setProviderModel(provider, modelSelect.value)
      toast(`Model set to ${modelSelect.value}`)
    })
    const keyField = h('input', {
      class: 'field',
      type: 'password',
      placeholder: `${info.label} API key`,
      value: key ?? '',
      autocomplete: 'off',
      'aria-label': `${info.label} API key`,
    }) as HTMLInputElement
    const reveal = h(
      'button',
      { class: 'icon-button', 'aria-label': 'Show key', style: 'width: 44px; height: 44px' },
      icon('eye'),
    )
    reveal.addEventListener('click', () => {
      keyField.type = keyField.type === 'password' ? 'text' : 'password'
    })
    const save = h('button', { class: 'button primary' }, 'Save key')
    save.addEventListener('click', async () => {
      const typed = keyField.value.trim()
      const ok = await setProviderKey(provider, typed)
      const readBack = await getProviderKey(provider)
      if (!ok) toast('Save failed - try again')
      else if (typed && readBack !== typed) toast('Saved, but it did not read back - try again')
      else toast(typed ? `${info.label} key saved` : 'Key cleared')
    })

    body.replaceChildren(
      segmented,
      h(
        'p',
        { class: 'caption', style: 'margin: 12px 0' },
        info.free
          ? `${info.label} has a free tier. Its free tier may use what you send to improve Google's products.`
          : `${info.label} is paid - billed by ${info.label} for what you use.`,
      ),
      modelSelect,
      h('div', { class: 'key-row', style: 'margin-top: 8px' }, keyField, reveal),
      h(
        'div',
        { class: 'button-row' },
        save,
        h(
          'a',
          { class: 'button', href: info.keyUrl, target: '_blank', rel: 'noopener' },
          'Get a key',
        ),
      ),
    )
  })()
  return card(
    h('h2', {}, 'AI'),
    h(
      'p',
      { class: 'caption', style: 'margin: 0 0 12px' },
      'Answers questions, runs actions it is asked for, and writes Jarvis Live cues and summaries. Keys stay on this phone only.',
    ),
    body,
  )
}

function textCard(
  heading: string,
  explain: string,
  placeholder: string,
  max: number,
  read: () => Promise<string | null>,
  write: (text: string) => Promise<boolean>,
): HTMLElement {
  const area = h('textarea', {
    class: 'field',
    placeholder,
    maxlength: String(max),
  }) as HTMLTextAreaElement
  void read().then(text => {
    area.value = text ?? ''
  })
  const save = h('button', { class: 'button primary' }, 'Save')
  save.addEventListener('click', async () => {
    const ok = await write(area.value.trim())
    toast(ok ? `${heading} saved` : 'Save failed - try again')
  })
  return card(
    h('h2', {}, heading),
    h('p', { class: 'caption', style: 'margin: 0 0 12px' }, explain),
    area,
    h('div', { class: 'button-row' }, save),
  )
}

function diagnosticsCard(): { el: HTMLElement; stop: () => void } {
  const list = h('ul', { class: 'log' })
  const paint = () => {
    list.replaceChildren(
      ...[...recentStatus()]
        .reverse()
        .map(entry =>
          h(
            'li',
            {},
            h('time', {}, new Date(entry.at).toLocaleTimeString([], { hour12: false })),
            ` ${entry.line}`,
          ),
        ),
    )
  }
  paint()
  const stop = onStatus(paint)
  return {
    el: card(
      h('h2', {}, 'Diagnostics'),
      h(
        'p',
        { class: 'caption', style: 'margin: 0 0 12px' },
        'What the app has been doing, newest first - the lines to send when something on the glasses does not work.',
      ),
      list,
    ),
    stop,
  }
}

export function settingsView(ctx: AppContext): Page {
  const diagnostics = diagnosticsCard()
  const body = h(
    'div',
    {},
    glassesCard(ctx),
    label('Jarvis'),
    aiCard(ctx),
    textCard(
      'About you',
      'A sentence or two Jarvis knows about you, so answers fit you.',
      "e.g. I'm a product manager learning to code - keep answers short and skip basics I know.",
      ABOUT_ME_MAX_CHARS,
      getAboutMe,
      setAboutMe,
    ),
    textCard(
      'Jarvis Live prep notes',
      'Background for your next conversation - who it is with, what it is about, what you want from it. Used for Live cues.',
      'e.g. Coffee with Sam, a recruiter at a fintech startup. I want to ask about the team and remote work.',
      PREP_NOTES_MAX_CHARS,
      getPrepNotes,
      setPrepNotes,
    ),
    label('Help'),
    diagnostics.el,
  )
  return { title: 'Settings', body, cleanup: () => diagnostics.stop() }
}
