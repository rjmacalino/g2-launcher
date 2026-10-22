import {
  assistantActionContext,
  assistantActions,
  runAssistantActions,
} from '../../core/assistantActions'
import { dispatchVoiceCommand } from '../../core/voiceDispatch'
import { getAboutMe } from '../../core/geminiSettings'
import { DEFAULT_LOCAL_INSTRUCTIONS, getLocalInstructions } from '../../core/localInstructions'
import { getModePreset, modeOf } from '../../core/modes'
import { CHAT_INSTRUCTION, WEARER_INSTRUCTION } from '../../core/llmTypes'
import { askModel } from '../../core/llm'
import type { LlmResult, LlmTurn } from '../../core/llmTypes'
import { getLlmConfig, providerInfo, type LlmConfig } from '../../core/llmSettings'
import { modelLabel } from '../../core/llmProviders'
import { buildDigest } from './digest'
import { chatSessions, type ChatMessage, type ChatSession } from './store'

// The thinking half of Jarvis (G2-70), shared by the glasses screen
// (tool.ts) and the phone (companion/main.ts): given a conversation ending
// in a question, ask the chosen AI with everything Jarvis knows - About
// You, the digest of other conversations, the actions it can take. Nothing
// here touches a screen, so the phone can use Jarvis with no glasses
// connected at all.

// Back-to-back messages from the same side are merged into one turn. A
// question the AI failed to answer stays in the history, so the next
// question asked after it would otherwise be a second "user" turn in a
// row - and every exchange in the providers' examples alternates.
export function toTurns(messages: readonly ChatMessage[]): LlmTurn[] {
  const turns: LlmTurn[] = []
  for (const m of messages) {
    const previous = turns[turns.length - 1]
    if (previous && previous.role === m.role) previous.text += `\n\n${m.text}`
    else turns.push({ role: m.role, text: m.text })
  }
  return turns
}

// Nothing in a request may wait forever (G2-84): on the glasses a stalled
// read or connection left Jarvis stuck with no answer. About You is extra
// context, so after a short wait the question goes without it; the whole
// answer gets a generous limit, after which the wearer sees an error and
// can retry. A reply arriving after that is ignored.
const ABOUT_ME_TIMEOUT_MS = 3000
const ANSWER_TIMEOUT_MS = 300_000

function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms)),
  ])
}

export type AskHooks = {
  // How long to wait for the answer; tests use a short one.
  timeoutMs?: number
  onText?: (textSoFar: string) => void
  onRetry?: (attempt: number, maxAttempts: number) => void
  // The mode when the chat is not saved yet (G2-139); else the chat's own.
  mode?: string
}

// One request: the conversation so far (ending with the question) to the
// AI, with Jarvis's context and actions. The caller runs any actions.
export async function askAssistant(
  llm: LlmConfig,
  history: readonly ChatMessage[],
  sessionId: string | null,
  { onText, onRetry, timeoutMs = ANSWER_TIMEOUT_MS, mode }: AskHooks = {},
): Promise<LlmResult> {
  // What Jarvis can do, not just answer (notes, timer - registered by
  // app/main.ts). The context is best effort and time-limited, so it never
  // holds the question up for long (see core/assistantActions.ts).
  const actions = assistantActions()
  const [actionContext, aboutMe, guide] = await Promise.all([
    actions.length > 0 ? assistantActionContext() : Promise.resolve(''),
    within(getAboutMe(), ABOUT_ME_TIMEOUT_MS, null),
    // The wearer's instructions for Jarvis (G2-95, G2-138), for every model:
    // who they are and how answers should be live in Settings, not here.
    within(getLocalInstructions(), ABOUT_ME_TIMEOUT_MS, DEFAULT_LOCAL_INSTRUCTIONS),
  ])
  // The chat's mode adds its own instructions after the shared ones (G2-139).
  const session = sessionId ? chatSessions.peek()?.find(s => s.id === sessionId) : undefined
  const modeId = modeOf(mode ?? session?.mode).id
  const preset = await within(getModePreset(modeId), ABOUT_ME_TIMEOUT_MS, modeOf(modeId).preset)
  const fullGuide = [guide, preset].filter(Boolean).join('\n\n')
  let timedOut = false
  const answer = askModel(llm, toTurns(history), {
    onText: onText && (text => !timedOut && onText(text)),
    onRetry,
    // The wearer's other recent conversations, from the in-memory copy
    // (peek, never a storage read - see store.ts). Empty if the startup
    // load has not finished yet; the question still goes out.
    background: buildDigest(chatSessions.peek() ?? [], sessionId),
    functions: actions.map(a => a.declaration),
    actionContext,
    aboutMe,
    guide: fullGuide,
    // Interview mode speaks as the wearer, not as Jarvis (G2-140).
    instruction: modeId === 'interview' ? WEARER_INSTRUCTION : CHAT_INSTRUCTION,
    // Questions about now - news, scores, prices, opening hours - need the
    // web; the model decides when (G2-76).
    webSearch: true,
  })
  const result = await within<LlmResult | null>(answer, timeoutMs, null)
  if (result) return result
  timedOut = true
  return { kind: 'error', message: `no answer in ${Math.round(timeoutMs / 1000)}s` }
}

export type PhoneAskResult =
  | { kind: 'answered'; session: ChatSession }
  | { kind: 'command'; reply: string; session: ChatSession | null }
  | { kind: 'error'; message: string; session: ChatSession }
  | { kind: 'no-key' }

// A question typed on the phone, from start to saved answer: a local
// command first (a timer needs no AI), otherwise the AI. The question is
// saved before the AI is asked - like on the glasses - so it is not lost
// if the request fails, and the glasses, watching the store, show it at
// once if that conversation is open there.
export async function askFromPhone(
  text: string,
  sessionId: string | null,
  hooks: AskHooks = {},
): Promise<PhoneAskResult> {
  const question: ChatMessage = { role: 'user', text: text.trim(), timestamp: Date.now() }
  const existing = sessionId
    ? (await chatSessions.readAll()).find(s => s.id === sessionId)
    : undefined

  const command = await dispatchVoiceCommand(question.text)
  if (command.handled) {
    if (!existing) return { kind: 'command', reply: command.message, session: null }
    const reply: ChatMessage = { role: 'model', text: command.message, timestamp: Date.now() }
    const session = { ...existing, messages: [...existing.messages, question, reply] }
    await chatSessions.save(session)
    return { kind: 'command', reply: command.message, session }
  }

  const llm = await getLlmConfig('phone')
  if (!llm) return { kind: 'no-key' }

  let session: ChatSession = existing
    ? { ...existing, messages: [...existing.messages, question] }
    : chatSessions.newSession(question)
  await chatSessions.save(session)

  const reply = await askAssistant(llm, session.messages, session.id, hooks)
  if (reply.kind === 'error') {
    return {
      kind: 'error',
      message: `Couldn't reach ${providerInfo(llm.provider).label} (${reply.message})`,
      session,
    }
  }
  // The reply to an action is what the action actually did, never the
  // model's own words about it (see core/assistantActions.ts).
  const replyText = reply.kind === 'actions' ? await runAssistantActions(reply.calls) : reply.text
  session = {
    ...session,
    messages: [
      ...session.messages,
      {
        role: 'model',
        text: replyText,
        timestamp: Date.now(),
        ...(reply.kind === 'answer' && reply.sources ? { sources: reply.sources } : {}),
        ...(reply.kind === 'answer'
          ? { model: modelLabel(llm.provider, reply.model ?? llm.model) }
          : {}),
      },
    ],
  }
  await chatSessions.save(session)
  return { kind: 'answered', session }
}
