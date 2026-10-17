// Server-sent events, as Gemini's and DeepSeek's streaming endpoints send
// them: events end with a blank line, and an event's payload is its
// "data:" lines joined. Returns the complete events in buffer and the
// unfinished remainder to prepend to the next piece of the stream. The
// end-of-stream marker "[DONE]" (DeepSeek, OpenAI style) is dropped.
export function parseSseEvents(buffer: string): { events: string[]; rest: string } {
  const blocks = buffer.replace(/\r\n?/g, '\n').split('\n\n')
  const rest = blocks.pop() ?? ''
  const events: string[] = []
  for (const block of blocks) {
    const data = block
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (data && data !== '[DONE]') events.push(data)
  }
  return { events, rest }
}

// Reads a fetch Response body as server-sent events, handing each event's
// payload to onEvent as it completes.
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (payload: string) => void,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const parsed = parseSseEvents(buffer + decoder.decode(value, { stream: true }))
    buffer = parsed.rest
    parsed.events.forEach(onEvent)
  }
  parseSseEvents(`${buffer}${decoder.decode()}\n\n`).events.forEach(onEvent)
}
