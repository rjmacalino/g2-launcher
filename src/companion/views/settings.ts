import { WINGMAN_ENABLED } from '../../shared/features'
import { bridge, onStatus, recentStatus } from '../../platform/bridge'
import { ABOUT_ME_MAX_CHARS, getAboutMe, setAboutMe } from '../../core/geminiSettings'
import {
  DEFAULT_LOCAL_INSTRUCTIONS,
  LOCAL_INSTRUCTIONS_MAX_CHARS,
  getLocalInstructions,
  setLocalInstructions,
} from '../../core/localInstructions'
import {
  PROVIDERS,
  getChoice,
  getProviderKey,
  providerInfo,
  providersWithKeys,
  setChoice,
  setProviderKey,
  type Provider,
  type Purpose,
} from '../../core/llmSettings'
import { isWakeWordEnabled, setWakeWordEnabled } from '../../core/wakeSettings'
import { CODE_SIZES, getCodeSize, loadCodeSize, setCodeSize } from '../../core/codeSize'
import { isWakeListening, wakeDescription } from '../../core/wakeListener'
import { getPrepNotes, setPrepNotes, PREP_NOTES_MAX_CHARS } from '../../features/live/settings'
import { getProfile, setProfile, PROFILE_MAX_CHARS } from '../../features/parakeet/settings'
import {
  TRANSCRIBERS,
  getTranscriber,
  setTranscriber,
  type Transcriber,
} from '../../core/transcriberSettings'
import type { AppContext, Page } from '../app'
import { h, icon, toast } from '../dom'
import { probeLongText } from '../../platform/textProbe'

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
      : 'Off. Open Jarvis from the glasses launcher to ask it something.'
  }
  void isWakeWordEnabled().then(paint)
  wakeSwitch.addEventListener('click', async () => {
    const on = !wakeSwitch.classList.contains('on')
    paint(on)
    await setWakeWordEnabled(on)
    setTimeout(() => paint(on), 800)
  })

  const sizeSelect = h(
    'select',
    { class: 'field', 'aria-label': 'Code size' },
    CODE_SIZES.map(px => h('option', { value: String(px) }, `${px} px`)),
  ) as HTMLSelectElement
  void loadCodeSize().then(() => (sizeSelect.value = String(getCodeSize())))
  sizeSelect.addEventListener('change', async () => {
    if (await setCodeSize(Number(sizeSelect.value))) toast('Code size saved')
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
    h('div', { style: 'margin-top: 16px' }, [
      h('div', { style: 'font-weight: 500' }, 'Code size on the glasses'),
      h(
        'p',
        { class: 'caption', style: 'margin: 4px 0 6px' },
        'Bigger is easier to read but shows fewer lines. Applies the next time you open code.',
      ),
      sizeSelect,
    ]),
  )
}

// How big Jarvis draws code on the glasses (G2-73). Opening a code
// answer on the glasses shows the change.
// Which provider's key the Keys section is showing; kept across redraws.
let editingKey: Provider = 'gemini'

const JOBS: { purpose: Purpose; title: string; hint: string }[] = [
  { purpose: 'glasses', title: 'Jarvis on the glasses', hint: 'Spoken questions - quick wins' },
  { purpose: 'phone', title: 'Jarvis on the phone', hint: 'Typed questions and code - depth wins' },
  // Wingman is switched off (G2-101, shared/features.ts), so no cue model.
  ...(WINGMAN_ENABLED
    ? [
        {
          purpose: 'wingman' as const,
          title: 'Wingman',
          hint: 'Cues mid-conversation - speed wins',
        },
      ]
    : []),
]

// Which speech-to-text Parakeet listens with (G2-134).
function transcriberCard(): HTMLElement {
  const select = h(
    'select',
    { class: 'field', 'aria-label': 'Parakeet transcriber' },
    TRANSCRIBERS.map(t => h('option', { value: t.id }, t.label)),
  ) as HTMLSelectElement
  void getTranscriber().then(choice => (select.value = choice))
  select.addEventListener('change', async () => {
    if (await setTranscriber(select.value as Transcriber)) toast('Transcriber saved')
  })
  return card(
    h('h2', {}, 'Parakeet: transcriber'),
    h(
      'p',
      { class: 'caption', style: 'margin: 4px 0 8px' },
      'How Parakeet turns speech into text. Gemini Live shows words as they are spoken and is free on the Gemini free tier. Whisper works offline on this phone but runs a few seconds behind. Applies the next time you open Parakeet.',
    ),
    select,
  )
}

// One job's model, from the providers there is a key for (G2-77).
async function jobPicker(
  job: (typeof JOBS)[number],
  withKeys: readonly Provider[],
): Promise<HTMLElement> {
  const choice = await getChoice(job.purpose)
  const select = h(
    'select',
    { class: 'field', 'aria-label': job.title },
    withKeys.map(id => {
      const info = providerInfo(id)
      const group = h(
        'optgroup',
        { label: info.label },
        info.models.map(m =>
          h(
            'option',
            {
              value: `${id}/${m.id}`,
              selected: id === choice.provider && m.id === choice.model,
            },
            `${m.label} - ${m.speed}`,
          ),
        ),
      )
      return group
    }),
  ) as HTMLSelectElement
  select.addEventListener('change', async () => {
    const [provider, model] = select.value.split('/') as [Provider, string]
    if (await setChoice(job.purpose, { provider, model })) toast(`${job.title} updated`)
  })
  return h(
    'div',
    { style: 'margin-top: 12px' },
    h('div', { class: 'section-label' }, job.title),
    h('div', { class: 'caption', style: 'margin: 0 0 6px' }, job.hint),
    select,
  )
}

function aiCard(ctx: AppContext): HTMLElement {
  const body = h('div', {}, h('div', { class: 'caption' }, 'Loading...'))
  void (async () => {
    const provider = editingKey
    const info = providerInfo(provider)
    const [key, withKeys] = await Promise.all([getProviderKey(provider), providersWithKeys()])

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
            onclick: () => {
              if (p.id === provider) return
              editingKey = p.id
              ctx.refresh()
            },
          },
          withKeys.includes(p.id) ? `${p.label} \u2713` : p.label,
        ),
      ),
    )
    const what = info.local ? 'PC address' : `${info.label} API key`
    const keyField = h('input', {
      class: 'field',
      type: info.local ? 'text' : 'password',
      placeholder: info.local ? 'PC address, e.g. 192.168.1.20' : what,
      value: key ?? '',
      autocomplete: 'off',
      'aria-label': what,
    }) as HTMLInputElement
    const reveal = h(
      'button',
      { class: 'icon-button', 'aria-label': 'Show key', style: 'width: 44px; height: 44px' },
      icon('eye'),
    )
    reveal.addEventListener('click', () => {
      keyField.type = keyField.type === 'password' ? 'text' : 'password'
    })
    const save = h('button', { class: 'button primary' }, info.local ? 'Save address' : 'Save key')
    save.addEventListener('click', async () => {
      const typed = keyField.value.trim()
      const ok = await setProviderKey(provider, typed)
      const readBack = await getProviderKey(provider)
      if (!ok) toast('Save failed - try again')
      else if (typed && readBack !== typed) toast('Saved, but it did not read back - try again')
      else toast(typed ? `${what} saved` : 'Cleared')
      // The model pickers list only providers with a key.
      ctx.refresh()
    })

    const jobs =
      withKeys.length === 0
        ? [h('p', { class: 'caption' }, 'Add a key above to choose models.')]
        : await Promise.all(JOBS.map(job => jobPicker(job, withKeys)))

    body.replaceChildren(
      label('Keys'),
      segmented,
      h(
        'p',
        { class: 'caption', style: 'margin: 12px 0' },
        info.local
          ? 'Free and unlimited: a small model on your own PC, with Ollama installed. Works while this phone is on the same Wi-Fi as the PC. Less clever than the others, and no web search.'
          : info.free
            ? `${info.label} has a free tier (a daily limit per model). Its free tier may use what you send to improve Google's products.`
            : `${info.label} is paid - billed by ${info.label} for what you use.${provider === 'deepseek' ? " It can't search the web, so it won't know about recent events." : ''}`,
      ),
      h('div', { class: 'key-row' }, keyField, reveal),
      h(
        'div',
        { class: 'button-row' },
        save,
        h(
          'a',
          { class: 'button', href: info.keyUrl, target: '_blank', rel: 'noopener' },
          info.local ? 'Get Ollama' : 'Get a key',
        ),
      ),
      h('div', { style: 'margin-top: 20px' }, label('Which model does what')),
      ...jobs,
    )
  })()
  return card(
    h('h2', {}, 'AI'),
    h(
      'p',
      { class: 'caption', style: 'margin: 0 0 12px' },
      'Answers your questions and runs actions it is asked for. Keys stay on this phone only.',
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
      h(
        'div',
        { class: 'button-row', style: 'margin-bottom: 12px' },
        h(
          'button',
          {
            class: 'button',
            onclick: async () => {
              toast('Open a Jarvis chat on the glasses, then look at them')
              await probeLongText('single')
              await probeLongText('append')
            },
          },
          'Test long text on glasses',
        ),
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
      'Instructions for Jarvis on your PC',
      "Like a CLAUDE.md: sent with every question to the model on your PC, which does better with a clear brief. Cloud AIs don't get it. Clear the box to go back to the default.",
      DEFAULT_LOCAL_INSTRUCTIONS,
      LOCAL_INSTRUCTIONS_MAX_CHARS,
      getLocalInstructions,
      setLocalInstructions,
    ),
    textCard(
      'About you',
      'A sentence or two Jarvis knows about you, so answers fit you.',
      "e.g. I'm a product manager learning to code - keep answers short and skip basics I know.",
      ABOUT_ME_MAX_CHARS,
      getAboutMe,
      setAboutMe,
    ),
    textCard(
      'Parakeet: who I am',
      'Parakeet answers in your voice. Write what it should know about you: work, studies, projects, strengths, hobbies, stories worth telling. The more here, the more your own the answers sound. It will not invent facts beyond this.',
      'e.g. I am a junior web developer, two years in. I build with React and TypeScript. For fun I hike and play badminton on weekends. My proudest project is a smart glasses app.',
      PROFILE_MAX_CHARS,
      getProfile,
      setProfile,
    ),
    transcriberCard(),
    WINGMAN_ENABLED
      ? textCard(
          'Wingman prep notes',
          'Background for your next conversation - who it is with, what it is about, what you want from it. Used for Live cues.',
          'e.g. Coffee with Sam, a recruiter at a fintech startup. I want to ask about the team and remote work.',
          PREP_NOTES_MAX_CHARS,
          getPrepNotes,
          setPrepNotes,
        )
      : null,
    label('Help'),
    diagnostics.el,
  )
  return { title: 'Settings', body, cleanup: () => diagnostics.stop() }
}
