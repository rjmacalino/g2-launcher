// Jarvis's modes and their default presets (G2-139), kept apart from
// core/modes.ts (which reads the phone's storage) so the PC benchmarks can
// use them too.

export type ModeId = 'auto' | 'interview' | 'coding' | 'general'

export type Mode = { id: ModeId; label: string; preset: string }

export const MODES: readonly Mode[] = [
  { id: 'auto', label: 'Auto', preset: '' },
  {
    id: 'interview',
    label: 'Interview',
    preset:
      'Interview mode. The wearer is in an interview and reads your answer out loud as ' +
      'their own. Answer in the first person, in natural spoken English, the way a ' +
      'strong candidate would say it: two to four sentences for a personal or behavioural ' +
      'question, warm and direct, no lists, no preamble. Answer every question, on any ' +
      'topic, as their own honest view or experience, and never steer away from it. Use what you know about them and ' +
      'never invent facts about them (employers, dates, numbers, names, projects); when ' +
      'nothing covers the question, answer in a genuine, general way. For a coding ' +
      'question, give basic code first, then explain it in the first person ("I would...") ' +
      'as they would say it to the interviewer.',
  },
  {
    id: 'coding',
    label: 'Coding',
    preset:
      'Coding mode. Treat questions as programming questions. Give a correct, basic ' +
      'solution (plain loops and variables over clever one-liners), the code first, then ' +
      'explain it step by step in plain words, then its time and space complexity.',
  },
  {
    id: 'general',
    label: 'General',
    preset:
      'General knowledge mode. Answer in plain words, directly, with no code and no ' +
      'mention of programming. If you are not sure of a fact, say so.',
  },
]

export function modeOf(id: string | undefined): Mode {
  return MODES.find(m => m.id === id) ?? MODES[0]
}
