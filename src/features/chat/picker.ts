import { modeOf, type ModeId } from '../../shared/modePresets'
import { LANGUAGES, type Language } from '../../shared/languages'
import type { ChatSession } from './store'

// The glasses' chat list for each launcher entry (G2-152, split out of
// tool.ts in G2-172): Jarvis, Interview and Code are one engine with a scope
// each - the new-chat rows its list starts with, and which saved chats it
// shows. Jarvis is general Q and A (Auto adapts to any topic). Pure.

export type Scope = 'jarvis' | 'interview' | 'code'
export type NewRow = { label: string; mode: ModeId; language?: Language }

const NEW_ROWS: Record<Scope, NewRow[]> = {
  jarvis: [{ label: 'New chat', mode: 'auto' }],
  interview: [{ label: 'New interview', mode: 'interview' }],
  code: LANGUAGES.map(language => ({
    label: `New: ${language}`,
    mode: 'coding' as const,
    language,
  })),
}

export function newRowsFor(scope: Scope): NewRow[] {
  return NEW_ROWS[scope]
}

export function inScope(session: ChatSession, scope: Scope): boolean {
  const mode = modeOf(session.mode).id
  if (scope === 'interview') return mode === 'interview'
  if (scope === 'code') return mode === 'coding'
  return mode !== 'interview' && mode !== 'coding'
}

// List containers have a firmware hard limit of 20 items (docs/platform.md).
// The new-chat rows come first, leaving the rest for saved sessions - after
// enough use to pass that count, a list of more than 20 made the firmware
// reject the rebuild outright, which looked like Jarvis silently refusing to
// open at all [HW]. Only the list is capped; nothing is deleted, and the
// companion page shows every session.
export function pickerMax(scope: Scope): number {
  return 20 - NEW_ROWS[scope].length
}

// Shorter than the 64-character list-item limit on purpose. Both open
// Gemini bugs [HW] - failing to open, and "Yes" on the leave prompt not
// landing back on this picker - only ever happened with saved chats, i.e.
// only when this list had titles in it. Titles were cut at exactly 64
// characters, right on the documented limit, so a firmware that really
// allows 63 plus a terminator would reject every long-question title.
// Unconfirmed, but the stored title is untouched - only what the list shows.
const PICKER_TITLE_MAX_CHARS = 40

export function pickerTitle(title: string): string {
  return title.length > PICKER_TITLE_MAX_CHARS
    ? `${title.slice(0, PICKER_TITLE_MAX_CHARS - 3)}...`
    : title
}

// The saved chats this entry's list shows: its own, newest first, capped.
export function sortForPicker(sessions: readonly ChatSession[], scope: Scope): ChatSession[] {
  return sessions
    .filter(s => inScope(s, scope))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, pickerMax(scope))
}
