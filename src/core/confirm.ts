import type { Tool } from './tool'

// A tool asking the wearer a Yes/No question of its own (G2-108): "Delete
// this chat?". The shell shows the same No/Yes list as its leave prompt,
// with No highlighted, and runs onYes only on Yes. A registered handler,
// the same way core/rebuild.ts keeps tools from importing the shell.
let handler: ((tool: Tool, prompt: string, onYes: () => void) => void) | null = null

export function registerConfirmHandler(
  fn: (tool: Tool, prompt: string, onYes: () => void) => void,
): void {
  handler = fn
}

export function requestConfirm(tool: Tool, prompt: string, onYes: () => void): void {
  handler?.(tool, prompt, onYes)
}
