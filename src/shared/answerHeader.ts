import { questionLine } from './questionKeywords'

// The two lines above every answer on the glasses (G2-200, RJ's layout):
//   Q: the question, boiled down to a line (questionKeywords.ts)
//   Mode: Interview - Model: DeepSeek Flash
// then the answer straight below, with no divider. A Jarvis (Auto) chat has
// no mode, so its second line is just "Model: ...". `label` is how the app
// names the answer's source: "Interview - DeepSeek Flash", "Code (Python) -
// DeepSeek Flash", or just "DeepSeek Flash". Pure.

export function modeModelLine(label: string): string {
  const cut = label.indexOf(' - ')
  if (cut < 0) return `Model: ${label}`
  return `Mode: ${label.slice(0, cut)} - Model: ${label.slice(cut + 3)}`
}

export function answerHeader(question: string, label: string | null): string {
  const q = `Q: ${questionLine(question)}`
  return label ? `${q}\n${modeModelLine(label)}` : q
}
