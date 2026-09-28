// The on-device speech-to-text engine, confirmed working end to end by
// Lab's "Whisper WASM init" probe (model load + inference both succeed in
// this WebView). Lives in core/, not features/jarvis, because more than one
// feature needs it (Jarvis's one-shot commands, Captions' running
// transcript) and features/* modules never import each other in this
// codebase - see core/rebuild.ts and core/voiceDispatch.ts for the same
// reasoning applied to other cross-feature infrastructure. Each caller's own
// service.ts still owns audio capture; this file's only job is turning
// samples into text.
const WHISPER_MODEL = 'Xenova/whisper-tiny.en'

function createPipeline() {
  return import('@huggingface/transformers').then(({ pipeline }) =>
    pipeline('automatic-speech-recognition', WHISPER_MODEL, { dtype: 'q8' }),
  )
}

// Loaded once and kept for the app's lifetime, not once per voice command -
// the load itself (downloading and initialising the model) takes real time,
// confirmed by the Lab probe, and paying that cost on every single command
// would make Jarvis unusable.
let pipelinePromise: ReturnType<typeof createPipeline> | null = null

function getPipeline() {
  if (!pipelinePromise) pipelinePromise = createPipeline()
  return pipelinePromise
}

// Called once at startup (see app/main.ts) so the model is hopefully already
// loaded, or at least already in flight, by the time the wearer first opens
// Jarvis. Not awaited there - a slow or failed load must not block startup,
// and a real failure still surfaces later through transcribe() itself,
// which is the call that actually needs to report it on screen.
export function preload() {
  getPipeline().catch(() => {})
}

export async function transcribe(audio: Float32Array): Promise<string> {
  const transcriber = await getPipeline()
  const result = await transcriber(audio)
  const first = Array.isArray(result) ? result[0] : result
  return first?.text?.trim() ?? ''
}
