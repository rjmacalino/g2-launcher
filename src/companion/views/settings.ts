import { bridge, onStatus, recentStatus } from '../../platform/bridge'
import { trace } from '../../shared/trace'
import { READING_STYLES, type ReadingStyle } from '../../shared/readingStyle'
import { getReadingStyle, setReadingStyle } from '../../core/readingSettings'
import { ABOUT_ME_MAX_CHARS, getAboutMe, setAboutMe } from '../../core/geminiSettings'
import {
  DEFAULT_LOCAL_INSTRUCTIONS,
  LOCAL_INSTRUCTIONS_MAX_CHARS,
  getLocalInstructions,
  resetLocalInstructions,
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
import {
  MODES,
  MODE_PRESET_MAX_CHARS,
  getModePreset,
  resetModePreset,
  setModePreset,
} from '../../core/modes'
import {
  TRANSCRIBERS,
  getAutoSendSeconds,
  getDeepgramKey,
  getSttGeminiKey,
  getTranscriber,
  setAutoSendSeconds,
  setDeepgramKey,
  setSttGeminiKey,
  setTranscriber,
  type Transcriber,
} from '../../core/transcriberSettings'
import { AUTO_SEND_SECONDS } from '../../shared/autoSend'
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
  // How long answers read (G2-191).
  const readingSelect = h(
    'select',
    { class: 'field', 'aria-label': 'Reading style' },
    READING_STYLES.map(s => h('option', { value: s.id }, s.label)),
  ) as HTMLSelectElement
  readingSelect.value = getReadingStyle()
  readingSelect.addEventListener('change', async () => {
    if (await setReadingStyle(readingSelect.value as ReadingStyle)) toast('Reading style saved')
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
    h('div', { style: 'margin-top: 16px' }, [
      h('div', { style: 'font-weight: 500' }, 'Reading long answers'),
      h(
        'p',
        { class: 'caption', style: 'margin: 4px 0 6px' },
        'The glasses always open text at its top, so going back up either opens the page above from its top (you can scroll), lands right above where you were, or turns one screen at a time with no scrolling. Applies to the next answer you open.',
      ),
      readingSelect,
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
]

// Which speech-to-text Jarvis listens with (G2-134, G2-135).
function transcriberCard(): HTMLElement {
  const select = h(
    'select',
    { class: 'field', 'aria-label': 'Transcriber' },
    TRANSCRIBERS.map(t => h('option', { value: t.id }, t.label)),
  ) as HTMLSelectElement
  // Speech to text has its own keys (G2-157, G2-166), separate from the AI
  // models' keys below: a box for the chosen engine only.
  const geminiBox = sttKeyBox({
    label: 'Gemini key for speech to text',
    hint: 'From aistudio.google.com. Separate from the key of the model that answers. Leave empty to use the Gemini key from AI models (answering).',
    keyUrl: 'https://aistudio.google.com/apikey',
    read: getSttGeminiKey,
    write: setSttGeminiKey,
  })
  const deepgramBox = sttKeyBox({
    label: 'Deepgram key',
    hint: 'From console.deepgram.com.',
    keyUrl: 'https://console.deepgram.com/',
    read: getDeepgramKey,
    write: setDeepgramKey,
  })
  const showKeyBox = () => {
    geminiBox.style.display = select.value === 'gemini-live' ? '' : 'none'
    deepgramBox.style.display = select.value === 'deepgram' ? '' : 'none'
  }
  void getTranscriber().then(choice => {
    select.value = choice
    showKeyBox()
  })
  select.addEventListener('change', async () => {
    showKeyBox()
    if (await setTranscriber(select.value as Transcriber)) toast('Transcriber saved')
  })
  return card(
    h('h2', {}, 'Speech to text'),
    h(
      'p',
      { class: 'caption', style: 'margin: 4px 0 8px' },
      'How Jarvis turns what you say into text. Gemini Live and Deepgram write the words while you speak, so the question is ready the moment you tap; the listening screen on the glasses shows which one is listening. Deepgram is tuned for coding terms. Whisper works offline on this phone but transcribes only after you tap, which is slower.',
    ),
    select,
    geminiBox,
    deepgramBox,
    autoSendBox(),
  )
}

// One speech-to-text key: a password field with a save button. Stored on
// this phone only, never bundled.
function sttKeyBox(key: {
  label: string
  hint: string
  keyUrl: string
  read: () => Promise<string | null>
  write: (value: string) => Promise<boolean>
}): HTMLElement {
  const field = h('input', {
    class: 'field',
    type: 'password',
    placeholder: key.label,
    autocomplete: 'off',
    'aria-label': key.label,
  }) as HTMLInputElement
  // The saved key arrives after the page draws; it never overwrites a key
  // already typed or pasted.
  void key.read().then(value => {
    if (field.value === '') field.value = value ?? ''
  })
  // Show/hide, as on the AI models key (G2-167): a password field's long
  // press may offer no Paste in the phone's WebView, so the key could not be
  // pasted; shown as text it can.
  const reveal = h(
    'button',
    { class: 'icon-button', 'aria-label': 'Show key', style: 'width: 44px; height: 44px' },
    icon('eye'),
  )
  reveal.addEventListener('click', () => {
    field.type = field.type === 'password' ? 'text' : 'password'
  })
  const save = h('button', { class: 'button primary' }, 'Save key')
  save.addEventListener('click', async () => {
    const typed = field.value.trim()
    if (!(await key.write(typed))) toast('Save failed - try again')
    else toast(typed ? `${key.label} saved` : 'Cleared')
  })
  return h(
    'div',
    { style: 'margin-top: 12px; display: none' },
    h('div', { class: 'section-label' }, key.label),
    h(
      'div',
      { class: 'caption', style: 'margin: 0 0 6px' },
      `${key.hint} Stored on this phone only.`,
    ),
    h('div', { class: 'key-row' }, field, reveal),
    h(
      'div',
      { class: 'button-row' },
      save,
      h('a', { class: 'button', href: key.keyUrl, target: '_blank', rel: 'noopener' }, 'Get a key'),
    ),
  )
}

// Auto-send when quiet (G2-158): off by default, so a question is never
// sent half-said and an AI request is not wasted.
function autoSendBox(): HTMLElement {
  const select = h('select', { class: 'field', 'aria-label': 'Auto-send when quiet' }, [
    h('option', { value: '0' }, 'Off - tap to send'),
    ...AUTO_SEND_SECONDS.map(s => h('option', { value: String(s) }, `After ${s} seconds of quiet`)),
  ]) as HTMLSelectElement
  void getAutoSendSeconds().then(seconds => (select.value = String(seconds)))
  select.addEventListener('change', async () => {
    if (await setAutoSendSeconds(Number(select.value))) toast('Auto-send saved')
  })
  return h(
    'div',
    { style: 'margin-top: 12px' },
    h('div', { class: 'section-label' }, 'Auto-send when quiet'),
    h(
      'div',
      { class: 'caption', style: 'margin: 0 0 6px' },
      'Off: the question is sent when you tap. On: it is also sent after you stay quiet this long. A recording where nothing is said still stops after a few seconds.',
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
    h('h2', {}, 'AI models (answering)'),
    h(
      'p',
      { class: 'caption', style: 'margin: 0 0 12px' },
      'The model that answers your questions and runs actions. These keys are for answering only; Speech to text has its own key in its section. Keys stay on this phone only.',
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
  // When given, a Reset to default button (G2-145).
  reset?: () => Promise<boolean>,
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
  const restore = reset ? h('button', { class: 'button' }, 'Reset to default') : null
  restore?.addEventListener('click', async () => {
    if (!reset || !(await reset())) {
      toast('Reset failed - try again')
      return
    }
    area.value = (await read()) ?? ''
    toast(`${heading} reset to default`)
  })
  return card(
    h('h2', {}, heading),
    h('p', { class: 'caption', style: 'margin: 0 0 12px' }, explain),
    area,
    h('div', { class: 'button-row' }, save, restore),
  )
}

// The hardware trace (G2-171, shared/trace.ts) for a bug report: copied to
// the clipboard, or shown to select by hand when the WebView refuses the
// clipboard. In dev also saved to bench/results/last-trace.json on the PC.
async function copyTrace(box: HTMLTextAreaElement): Promise<void> {
  const text = trace.toJson()
  import.meta.hot?.send('companion:trace', text)
  try {
    await navigator.clipboard.writeText(text)
    toast('Trace copied - paste it into a message')
    return
  } catch {
    box.value = text
    box.style.display = ''
    box.focus()
    box.select()
    toast('Select all in the box and copy it')
  }
}

function diagnosticsCard(): { el: HTMLElement; stop: () => void } {
  const list = h('ul', { class: 'log' })
  const traceBox = h('textarea', {
    class: 'field',
    readonly: true,
    rows: 6,
    'aria-label': 'Trace',
    style: 'display: none; margin-bottom: 12px',
  }) as HTMLTextAreaElement
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
        h('button', { class: 'button', onclick: () => void copyTrace(traceBox) }, 'Copy trace'),
      ),
      traceBox,
      list,
    ),
    stop,
  }
}

// Settings in three tabs (G2-181) instead of one long scroll: what you set
// once for listening, what answers, and the text and diagnostics behind it.
type SettingsTab = 'voice' | 'answers' | 'advanced'
const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: 'voice', label: 'Voice' },
  { id: 'answers', label: 'Answers' },
  { id: 'advanced', label: 'Advanced' },
]
let settingsTab: SettingsTab = 'voice'

export function settingsView(ctx: AppContext): Page {
  const tabs = h(
    'div',
    { class: 'segmented', role: 'tablist', style: 'margin-bottom: 12px' },
    SETTINGS_TABS.map(t =>
      h(
        'button',
        {
          class: t.id === settingsTab ? 'on' : '',
          role: 'tab',
          'aria-selected': String(t.id === settingsTab),
          onclick: () => {
            if (t.id === settingsTab) return
            settingsTab = t.id
            ctx.refresh()
          },
        },
        t.label,
      ),
    ),
  )
  if (settingsTab === 'voice') {
    return { title: 'Settings', body: h('div', {}, tabs, glassesCard(ctx), transcriberCard()) }
  }
  if (settingsTab === 'answers') {
    return {
      title: 'Settings',
      body: h(
        'div',
        {},
        tabs,
        aiCard(ctx),
        textCard(
          'About you',
          'A sentence or two Jarvis knows about you, so answers fit you.',
          "e.g. I'm a product manager learning to code - keep answers short and skip basics I know.",
          ABOUT_ME_MAX_CHARS,
          getAboutMe,
          setAboutMe,
        ),
      ),
    }
  }
  const diagnostics = diagnosticsCard()
  const body = h(
    'div',
    {},
    tabs,
    textCard(
      'Instructions for Jarvis',
      'Like a CLAUDE.md: who you are and how you want answers. Sent with every question to whichever AI answers. Edit it freely. Save an empty box to send no instructions; Reset to default brings the starting text back.',
      DEFAULT_LOCAL_INSTRUCTIONS,
      LOCAL_INSTRUCTIONS_MAX_CHARS,
      getLocalInstructions,
      setLocalInstructions,
      resetLocalInstructions,
    ),
    // One editable preset per mode (G2-139); picked per chat on the glasses
    // with "New chat: Interview" and so on. Auto has none.
    ...MODES.filter(m => m.id !== 'auto').map(m =>
      textCard(
        `${m.label} mode`,
        `Added to the instructions above in a "New chat: ${m.label}" chat. Save an empty box to turn it off; Reset to default brings the starting text back.`,
        m.preset,
        MODE_PRESET_MAX_CHARS,
        () => getModePreset(m.id),
        text => setModePreset(m.id, text),
        () => resetModePreset(m.id),
      ),
    ),
    label('Help'),
    diagnostics.el,
  )
  return { title: 'Settings', body, cleanup: () => diagnostics.stop() }
}
