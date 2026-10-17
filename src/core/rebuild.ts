import type { Tool } from './tool'

// A tool whose data changes out from under it (Weather's background refresh,
// see features/weather/service.ts) needs a way to ask the shell to redraw its OWN
// currently-open page once new data lands. There is no in-place list content
// upgrade in this SDK (see platform/page.ts), only a full rebuildPageContainer, so
// "redraw me" has to go through the shell either way.
//
// A registered callback rather than a tool importing app/main.ts directly: main
// already imports the tools array, so a tool importing back from main would
// be a circular module dependency. Registering a handler here at startup
// keeps the coupling one small function wide instead of a cycle.
let handler: ((tool: Tool, after?: () => void) => void) | null = null

export function registerRebuildHandler(fn: (tool: Tool, after?: () => void) => void) {
  handler = fn
}

// The handler is responsible for verifying the given tool is actually the
// one on screen right now before touching anything - a caller's own "am I
// open" flag is a hint, not proof, for the same reason a late async
// callback always re-checks before acting (see the `active`/`isOpen` guards
// this pattern grew out of, e.g. the old GPS tool).
// after runs once the rebuilt page is on screen, if it is rebuilt at all.
export function requestRebuild(tool: Tool, after?: () => void) {
  handler?.(tool, after)
}
