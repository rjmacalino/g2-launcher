import { AudioInputSource, OsEventTypeList } from '@evenrealities/even_hub_sdk'
import {
  IMAGE_MAX_HEIGHT,
  IMAGE_MAX_WIDTH,
  setBrightness,
  setContent,
  setContentPartial,
  setImage,
} from '../../platform/page'
import { bridge, status } from '../../platform/bridge'
import { GLYPH_CANDIDATES } from './glyphs'
import { drawAllBlack, drawTestPattern } from './test-pattern'
import { drawWeatherIcon, WEATHER_ICON_CONDITIONS } from '../../ui/icons'
import { ICON_SIZE } from '../../ui/tokens'
import type { Tool } from '../../core/tool'

// Dev-only: a menu of hardware probes for facts docs/platform.md marks
// [UNVERIFIED by us]. Not a feature, and not shipped - excluded from TOOLS
// in registry.ts unless import.meta.env.DEV, which Vite strips from a
// production build entirely (the whole features/lab import disappears, not
// just a hidden menu entry).
//
// Same picker/detail depth every other multi-screen tool here uses
// (Notes, Teleprompter, Weather): a list of probes, then whichever one was
// picked takes over the content area.
type Probe = {
  readonly name: string
  readonly kind: 'text' | 'image'
  // Text probes compute their content synchronously, same constraint
  // initialContent() always had. Image probes draw and send asynchronously
  // from onOpen, since pixels can only go to a container that already exists
  // on screen (see Tool.imageSize in core/tool.ts).
  content?(): string
  // Only meaningful for kind: 'image'. Defaults to the platform maximum
  // (288 x 144) when omitted, same as Tool.imageSize's own default.
  imageSize?(): { width: number; height: number }
  onOpen?(): void
  onClose?(): void
  onLongPress?(): void
  contextMenu?(): { itemName: string; itemID: number }[]
  onMenuItemClick?(itemID: number): void
}

const BRIGHTNESS_LEVELS = [0, 1, 2, 3, 4] as const
let brightnessLevel = 4

const PARTIAL_UPDATE_LINES = Array.from(
  { length: 20 },
  (_, i) => `line ${String(i + 1).padStart(2, '0')}`,
)
let partialUpdateCount = 0

let micFrameCount = 0
let micLastSpeaker = 'none yet'
let micUnsubscribe: (() => void) | null = null

let imuLast = { x: 0, y: 0, z: 0 }
let imuUnsubscribe: (() => void) | null = null

let deviceStatusText = 'Loading...'
let iconIndex = 0

const CONTEXT_MENU_ITEM_A = 1
const CONTEXT_MENU_ITEM_B = 2

const probes: readonly Probe[] = [
  {
    name: 'Draw + long-press to clear',
    kind: 'image',
    onOpen: () => {
      drawTestPattern()
        .then(setImage)
        .then(result => status(`Lab: draw result ${result}`))
        .catch(e => status(`Lab: draw threw ${e instanceof Error ? e.message : String(e)}`))
    },
    onLongPress: () => {
      drawAllBlack()
        .then(setImage)
        .then(result => status(`Lab: clear-to-black result ${result}`))
        .catch(e => status(`Lab: clear threw ${e instanceof Error ? e.message : String(e)}`))
    },
  },
  {
    name: 'Glyph sheet',
    kind: 'text',
    content: () => GLYPH_CANDIDATES.map(g => `${g.char} ${g.label}`).join('\n'),
  },
  {
    name: 'Text brightness (long-press cycles)',
    kind: 'text',
    content: () => `Brightness level: ${brightnessLevel}\n(long-press to cycle 4 -> 0 -> 4)`,
    onOpen: () => {
      brightnessLevel = 4
    },
    onLongPress: () => {
      const i = BRIGHTNESS_LEVELS.indexOf(brightnessLevel as (typeof BRIGHTNESS_LEVELS)[number])
      brightnessLevel =
        BRIGHTNESS_LEVELS[(i + BRIGHTNESS_LEVELS.length - 1) % BRIGHTNESS_LEVELS.length]
      setBrightness(brightnessLevel).then(ok =>
        status(`Lab: brightness ${brightnessLevel} -> ${ok}`),
      )
    },
  },
  {
    // 20 lines overflow the content area, so this also has to scroll before
    // the actual question (does a partial update preserve scroll position
    // the way a brightness-only update does?) means anything - scroll down
    // first, then long-press, then check whether the view jumped back to
    // line 01 or stayed where it was.
    name: 'Partial update (scroll first, long-press replaces line 1)',
    kind: 'text',
    content: () => PARTIAL_UPDATE_LINES.join('\n'),
    onOpen: () => {
      partialUpdateCount = 0
    },
    onLongPress: () => {
      partialUpdateCount += 1
      const replacement = `LINE ${partialUpdateCount}`.padEnd(PARTIAL_UPDATE_LINES[0].length)
      setContentPartial(replacement, 0, PARTIAL_UPDATE_LINES[0].length).then(ok =>
        status(`Lab: partial update -> ${ok}`),
      )
    },
  },
  {
    name: 'Contextual menu (tap then long-press to open it)',
    kind: 'text',
    content: () => 'Open the contextual menu (tap, then long-press) and pick an item.',
    contextMenu: () => [
      { itemName: 'Probe item A', itemID: CONTEXT_MENU_ITEM_A },
      { itemName: 'Probe item B', itemID: CONTEXT_MENU_ITEM_B },
    ],
    onMenuItemClick: itemID => {
      status(`Lab: menu item clicked, itemID ${itemID}`)
    },
  },
  {
    name: 'Glasses microphone (long-press to stop)',
    kind: 'text',
    content: () =>
      `Frames: ${micFrameCount}\nLast speakerRole: ${micLastSpeaker}\n(long-press to stop)`,
    onOpen: () => {
      micFrameCount = 0
      micLastSpeaker = 'none yet'
      micUnsubscribe = bridge.onEvenHubEvent(event => {
        const audio = event.audioEvent
        if (!audio) return
        micFrameCount += 1
        micLastSpeaker = String(audio.speakerRole)
        setContent(
          `Frames: ${micFrameCount}\nLast speakerRole: ${micLastSpeaker}\n(long-press to stop)`,
        )
      })
      bridge.audioControl(true, AudioInputSource.Glasses).then(ok => status(`Lab: mic on -> ${ok}`))
    },
    onClose: () => {
      micUnsubscribe?.()
      micUnsubscribe = null
      bridge.audioControl(false)
    },
    onLongPress: () => {
      micUnsubscribe?.()
      micUnsubscribe = null
      bridge.audioControl(false).then(ok => status(`Lab: mic off -> ${ok}`))
    },
  },
  {
    name: 'IMU stream (long-press to stop)',
    kind: 'text',
    content: () => `x: ${imuLast.x}\ny: ${imuLast.y}\nz: ${imuLast.z}\n(long-press to stop)`,
    onOpen: () => {
      imuLast = { x: 0, y: 0, z: 0 }
      imuUnsubscribe = bridge.onEvenHubEvent(event => {
        const sys = event.sysEvent
        if (sys?.eventType !== OsEventTypeList.IMU_DATA_REPORT || !sys.imuData) return
        imuLast = { x: sys.imuData.x ?? 0, y: sys.imuData.y ?? 0, z: sys.imuData.z ?? 0 }
        setContent(`x: ${imuLast.x}\ny: ${imuLast.y}\nz: ${imuLast.z}\n(long-press to stop)`)
      })
      bridge.imuControl(true).then(ok => status(`Lab: IMU on -> ${ok}`))
    },
    onClose: () => {
      imuUnsubscribe?.()
      imuUnsubscribe = null
      bridge.imuControl(false)
    },
    onLongPress: () => {
      imuUnsubscribe?.()
      imuUnsubscribe = null
      bridge.imuControl(false).then(ok => status(`Lab: IMU off -> ${ok}`))
    },
  },
  {
    name: 'Device and user status',
    kind: 'text',
    content: () => deviceStatusText,
    onOpen: () => {
      deviceStatusText = 'Loading...'
      Promise.all([bridge.getDeviceInfo(), bridge.getUserInfo()])
        .then(([device, user]) => {
          deviceStatusText = device
            ? [
                `Model: ${device.model}`,
                `Battery: ${device.status.batteryLevel ?? 'unknown'}`,
                `Wearing: ${device.status.isWearing ?? 'unknown'}`,
                `Charging: ${device.status.isCharging ?? 'unknown'}`,
                `User: ${user.name || '(none)'}`,
              ].join('\n')
            : 'getDeviceInfo() returned null'
          setContent(deviceStatusText)
        })
        .catch(e => {
          deviceStatusText = `Failed: ${e instanceof Error ? e.message : String(e)}`
          setContent(deviceStatusText)
        })
    },
  },
  {
    // Runs in the phone's WebView JS context, not through the SDK at all -
    // this is the one probe testing something the Even app itself has no
    // opinion on. Only checks presence and construction; does not start a
    // live recognition session unprompted, since that would mean the mic
    // permission prompt firing just from opening this menu item.
    name: 'Browser SpeechRecognition (presence check only)',
    kind: 'text',
    content: () => {
      const w = window as unknown as Record<string, unknown>
      const ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
      if (!ctor) return 'window.SpeechRecognition: not present'
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        new (ctor as any)()
        return 'window.SpeechRecognition: present, constructs without throwing'
      } catch (e) {
        return `window.SpeechRecognition: present, but threw: ${e instanceof Error ? e.message : String(e)}`
      }
    },
  },
  {
    name: 'Album pick (long-press to open picker)',
    kind: 'image',
    onLongPress: () => {
      bridge
        .pickImageFromAlbum()
        .then(asset => {
          if (!asset) {
            status('Lab: album pick cancelled or returned null')
            return
          }
          status(`Lab: album pick got ${asset.mimeType}, ${asset.size} bytes`)
          return setImage(asset.base64).then(result => status(`Lab: album image send -> ${result}`))
        })
        .catch(e => status(`Lab: album pick threw ${e instanceof Error ? e.message : String(e)}`))
    },
  },
  {
    name: 'Icon set (long-press cycles)',
    kind: 'image',
    // A small container, not the platform maximum: real icon usage (a
    // weather condition next to a temperature, say) wants a modest fixed
    // size, not 288 x 144 stretched around a 24px drawing.
    imageSize: () => ({ width: ICON_SIZE, height: ICON_SIZE }),
    onOpen: () => {
      iconIndex = 0
      drawWeatherIcon(WEATHER_ICON_CONDITIONS[iconIndex])
        .then(setImage)
        .then(result => status(`Lab: icon ${WEATHER_ICON_CONDITIONS[iconIndex]} -> ${result}`))
        .catch(e => status(`Lab: icon draw threw ${e instanceof Error ? e.message : String(e)}`))
    },
    onLongPress: () => {
      iconIndex = (iconIndex + 1) % WEATHER_ICON_CONDITIONS.length
      drawWeatherIcon(WEATHER_ICON_CONDITIONS[iconIndex])
        .then(setImage)
        .then(result => status(`Lab: icon ${WEATHER_ICON_CONDITIONS[iconIndex]} -> ${result}`))
        .catch(e => status(`Lab: icon draw threw ${e instanceof Error ? e.message : String(e)}`))
    },
  },
]

type Depth = 'menu' | 'result'
let depth: Depth = 'menu'
let selectedIndex = 0

function selectedProbe(): Probe | null {
  return probes[selectedIndex] ?? null
}

export const labTool: Tool = {
  name: 'Lab',
  confirmOnExit: () => true,
  confirmPrompt: () => (depth === 'result' ? 'Leave this test?' : 'Leave Lab?'),
  contentKind: () => {
    if (depth === 'menu') return 'list'
    return selectedProbe()?.kind ?? 'text'
  },
  listItems: () => probes.map(p => p.name),
  imageSize: () =>
    selectedProbe()?.imageSize?.() ?? { width: IMAGE_MAX_WIDTH, height: IMAGE_MAX_HEIGHT },
  onListSelect: index => {
    if (depth !== 'menu') return
    if (!probes[index]) return
    selectedIndex = index
    depth = 'result'
  },
  onConfirmedExit: () => {
    if (depth === 'result') {
      selectedProbe()?.onClose?.()
      depth = 'menu'
      return 'tool'
    }
    return 'menu'
  },
  // Selecting a probe from the menu is an internal transition (onListSelect,
  // not openTool), so the shell calls onContentReady, not onOpen, once the
  // rebuilt page (with the probe's own container already on screen) lands -
  // see onContentReady in core/tool.ts for why the distinction matters here
  // specifically: an image probe cannot send pixels before its container
  // exists, and a probe with a live subscription (mic, IMU) cannot start it
  // before the container it will update exists either.
  onContentReady: () => {
    if (depth === 'result') selectedProbe()?.onOpen?.()
  },
  onClose: () => {
    if (depth === 'result') selectedProbe()?.onClose?.()
    depth = 'menu'
  },
  onLongPress: () => {
    if (depth === 'result') selectedProbe()?.onLongPress?.()
  },
  contextMenu: () => (depth === 'result' ? (selectedProbe()?.contextMenu?.() ?? []) : []),
  onMenuItemClick: itemID => {
    if (depth === 'result') selectedProbe()?.onMenuItemClick?.(itemID)
  },
  initialContent: () => selectedProbe()?.content?.() ?? '',
}
