// Voice navigation (G2-150): "Hey Jarvis, go back", "... open notes",
// "... scroll down". Recognised here, locally and instantly, from the whole
// transcript - only a short utterance that IS a command counts, so "how do I
// go back in git?" stays a question for the AI. Pure, tested in
// tests/nav-commands.test.ts.

export type NavCommand =
  | { kind: 'back' }
  | { kind: 'home' }
  | { kind: 'scroll'; delta: 1 | -1 }
  | { kind: 'open'; tool: 'Jarvis' | 'Notes' }
  | { kind: 'newChat'; mode: 'auto' | 'interview' | 'coding' | 'general' }
  | { kind: 'newList'; name: string }

// Politeness and fillers around a command, dropped before matching.
const FILLER =
  /\b(please|can you|could you|would you|ok|okay|now|for me|thanks|thank you|just|um|uh)\b/g

function clean(transcript: string): string {
  return (
    transcript
      .toLowerCase()
      .replace(/[^a-z0-9' ]+/g, ' ')
      // A leftover wake phrase at the start, not "open jarvis" at the end.
      .replace(/^\s*(hey )?jarvis\b/, ' ')
      .replace(/^\s*hey\b/, ' ')
      .replace(FILLER, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

const BACK =
  /^(go back|back|go back one|exit|exit chat|exit this|close|close this|close chat|close this chat|leave|leave this|leave chat|leave this chat|step back|return)$/
const HOME =
  /^(go home|home|go to the (home|launcher|menu|home screen)|go to (home|launcher|menu)|open (the )?(launcher|menu|home screen)|(the )?main menu|go to (the )?main menu|launcher)$/
const DOWN = /^(scroll down|page down|next page|go down|down|scroll|more|show more|keep going)$/
const UP = /^(scroll up|page up|previous page|last page|go up|up|back up)$/
const OPEN =
  /^(open|go to|show|show me|start|launch) (my |the )?(jarvis|notes|note|lists|list|checklists)$/
const NEW_CHAT =
  /^(?:(?:start|open) (?:a )?)?new (interview |coding |general )?(?:chat|conversation)$/
const NEW_LIST =
  /^(create|make|start|add|new)( a)?( new)? (note|list|checklist)( called| named| for)? (.+)$/

export function parseNavCommand(transcript: string): NavCommand | null {
  const text = clean(transcript)
  if (!text || text.split(' ').length > 8) return null
  if (BACK.test(text)) return { kind: 'back' }
  if (HOME.test(text)) return { kind: 'home' }
  if (DOWN.test(text)) return { kind: 'scroll', delta: 1 }
  if (UP.test(text)) return { kind: 'scroll', delta: -1 }
  const open = OPEN.exec(text)
  if (open) return { kind: 'open', tool: open[3] === 'jarvis' ? 'Jarvis' : 'Notes' }
  const chat = NEW_CHAT.exec(text)
  if (chat) {
    const mode = (chat[1]?.trim() || 'auto') as 'auto' | 'interview' | 'coding' | 'general'
    return { kind: 'newChat', mode }
  }
  const list = NEW_LIST.exec(text)
  if (list) {
    const name = list[6].trim()
    if (name) return { kind: 'newList', name: name.replace(/\b\w/g, c => c.toUpperCase()) }
  }
  return null
}
