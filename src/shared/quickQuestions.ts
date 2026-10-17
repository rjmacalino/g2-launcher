// Questions the app can answer itself, instantly, with no AI request
// (G2-76): the time, the date, and the weather it already fetches for the
// status bar. Answered before anything goes to the AI, so they cost
// nothing against the free tier's daily limit. Only whole, short questions
// match - "what time does the movie start" is not "what time is it" - and
// anything else goes to the AI as before. Pure; tested in
// tests/quick-questions.test.ts.

export type QuickQuestion =
  | { kind: 'time' }
  | { kind: 'date' }
  | { kind: 'weather'; when: 'now' | 'today' | 'tomorrow' }
  | { kind: 'rain'; when: 'today' | 'tomorrow' }

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(hey |ok |okay )?jarvis /, '')
    .replace(/^(please |so |um |uh )/, '')
    .replace(/ (please|now|right now)$/, '')
}

export function parseQuickQuestion(text: string): QuickQuestion | null {
  const q = normalise(text)
  if (
    /^(what time is it|what's the time|what is the time|time|the time|tell me the time)$/.test(q)
  ) {
    return { kind: 'time' }
  }
  if (
    /^(what's the date|what is the date|what's today's date|what is today's date|what day is it|what day is it today|what's today|what is today|date|today's date)( today)?$/.test(
      q,
    )
  ) {
    return { kind: 'date' }
  }
  const weather =
    /^(what's|what is|how's|how is) the weather( like)?( (today|now|outside|tomorrow))?$|^(weather|the weather|weather forecast|forecast)( (today|now|tomorrow))?$/.exec(
      q,
    )
  if (weather) {
    const when = /tomorrow/.test(q) ? 'tomorrow' : /today/.test(q) ? 'today' : 'now'
    return { kind: 'weather', when }
  }
  if (
    /^(will it|is it going to|is it gonna|should i expect it to) rain( today| tomorrow)?$/.test(q)
  ) {
    return { kind: 'rain', when: /tomorrow/.test(q) ? 'tomorrow' : 'today' }
  }
  return null
}
