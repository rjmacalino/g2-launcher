// The languages a Code chat can be in (G2-152): picked with "New: Python"
// and so on in the Code entry's list, kept on the chat, and passed to the AI
// with the language rule in src/defaults/instructions.json.
export const LANGUAGES = ['Python', 'JavaScript', 'TypeScript', 'C#'] as const

export type Language = (typeof LANGUAGES)[number]

// A spoken or typed name to one of LANGUAGES ("c sharp", "js", "type script").
export function languageOf(said: string): Language | null {
  const t = said.toLowerCase().replace(/[^a-z#+]/g, '')
  if (t === 'python' || t === 'py') return 'Python'
  if (t === 'javascript' || t === 'js') return 'JavaScript'
  if (t === 'typescript' || t === 'ts') return 'TypeScript'
  if (t === 'c#' || t === 'csharp' || t === 'see#' || t === 'seesharp') return 'C#'
  return null
}
