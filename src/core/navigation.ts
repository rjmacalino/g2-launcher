import type { NavCommand } from '../shared/navCommands'

// Voice navigation (G2-150): Jarvis recognises "Hey Jarvis, go back" and the
// like (shared/navCommands.ts), but moving between screens is the shell's
// job (app/main.ts). A registered handler, the same indirection as
// core/voiceDispatch.ts and core/rebuild.ts, so features never import the
// shell. Scrolling stays with Jarvis, which owns its pages.
export type ShellNavCommand = Exclude<NavCommand, { kind: 'scroll' }>

let handler: ((command: ShellNavCommand) => void) | null = null

export function registerNavigator(fn: (command: ShellNavCommand) => void): void {
  handler = fn
}

export function navigate(command: ShellNavCommand): void {
  handler?.(command)
}
