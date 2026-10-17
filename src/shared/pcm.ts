// The glasses mic delivers signed 16-bit little-endian PCM, 16 kHz mono,
// 100 ms per event (see docs/platform.md, Device APIs). Whisper wants
// Float32 samples in [-1, 1]. Pure helpers, shared by core/voiceCapture.ts
// (one recording) and Lab's live transcription probe (a continuous stream).
export const SAMPLE_RATE = 16_000

export function toFloat32(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const samples = new Float32Array(Math.floor(bytes.length / 2))
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * 2, true) / 32768
  }
  return samples
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

// Two bytes per sample.
export function bytesToSeconds(byteCount: number): number {
  return byteCount / 2 / SAMPLE_RATE
}
