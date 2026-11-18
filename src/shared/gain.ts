// Automatic gain for live transcription (G2-136): streaming transcribers hear
// quiet speech badly (a recording at a 0.04 peak - what speaker-to-mic gives
// in the simulator - came back from Gemini Live as three words), while
// Whisper copes. Each frame is raised towards a 0.5 peak, judged on the
// loudest of the last couple of seconds so the level does not pump between
// words, and never more than MAX_GAIN, so a quiet room is not blown up into
// noise. Input and output are 16-bit little-endian mono PCM.

const MAX_GAIN = 16

export function createAutoGain(): (pcm: Uint8Array) => Uint8Array {
  let recentPeak = 0
  return pcm => {
    // A copy: a frame can start at an odd byte offset, which an Int16Array
    // view cannot.
    const samples = new Int16Array(pcm.slice(0, pcm.length - (pcm.length % 2)).buffer)
    let peak = 0
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i])
      if (v > peak) peak = v
    }
    // Decays by about half over two seconds of 40 ms frames.
    recentPeak = Math.max(peak, recentPeak * 0.985)
    const gain = Math.min(MAX_GAIN, Math.max(1, (0.5 * 32767) / Math.max(1, recentPeak)))
    if (gain === 1) return pcm
    const out = new Int16Array(samples.length)
    for (let i = 0; i < samples.length; i++) {
      out[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * gain)))
    }
    return new Uint8Array(out.buffer)
  }
}
