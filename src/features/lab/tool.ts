import { setImage } from '../../platform/page'
import { status } from '../../platform/bridge'
import { GLYPH_CANDIDATES } from './glyphs'
import { drawAllBlack, drawTestPattern } from './test-pattern'
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
  onOpen?(): void
  onLongPress?(): void
}

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
  onListSelect: index => {
    if (depth !== 'menu') return
    if (!probes[index]) return
    selectedIndex = index
    depth = 'result'
  },
  onConfirmedExit: () => {
    if (depth === 'result') {
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
  // exists.
  onContentReady: () => {
    if (depth === 'result') selectedProbe()?.onOpen?.()
  },
  onClose: () => {
    depth = 'menu'
  },
  onLongPress: () => {
    if (depth === 'result') selectedProbe()?.onLongPress?.()
  },
  initialContent: () => selectedProbe()?.content?.() ?? '',
}
