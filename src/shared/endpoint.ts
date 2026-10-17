// Deciding when someone has finished speaking (G2-64), so a recording
// started by "Hey Jarvis" ends on its own like a phone assistant's does,
// instead of waiting for a tap. Pure: fed one loudness value per mic event
// (100 ms), it says whether to keep listening.
//
// Loudness is judged against the room, not a fixed level: the quiet floor
// is the quietest recent moment, rising only slowly, and speech is
// anything clearly above it. The glasses' real levels have not been
// measured yet, so every number here is a first guess to tune on hardware
// - the status line reports the levels seen for that.

export type EndpointDecision = 'listening' | 'finished' | 'no-speech' | 'too-long'

export type EndpointOptions = {
  // The quiet floor to start from - the quietest moment in the audio just
  // before recording started, when there is some.
  initialFloor?: number
  // The wearer was already talking when recording started ("Hey Jarvis,
  // set a timer" in one breath): count that as speech heard, so quiet
  // after it ends the recording instead of waiting for more.
  alreadySpeaking?: boolean
  frameMs?: number
  // Quiet this long after speech means they are done.
  silenceMs?: number
  // No speech at all for this long means they are not going to speak.
  noSpeechMs?: number
  maxMs?: number
}

// Speech is this many times louder than the quiet floor... Lowered from 3
// after the simulator heard speech from the PC's speakers at 2.5x the room
// [LAB-SIM]; on the glasses the mic is far closer to the mouth than that.
const SPEECH_RATIO = 2
// ...and at least this loud (RMS of samples scaled to [-1, 1], around
// their average - see rmsLevel), so a near-silent room's tiny fluctuations
// never count as speech.
const MIN_SPEECH_RMS = 0.001
// A single loud frame (a tap on the frame, a cough) is not speech.
const MIN_SPEECH_FRAMES = 3

// The loudness rules, shared with Wingman's segmenter
// (features/live/segmenter.ts) so both judge speech the same way.
export function isSpeech(rms: number, floor: number, ratio: number = SPEECH_RATIO): boolean {
  return rms >= Math.max(floor * ratio, MIN_SPEECH_RMS)
}

// Down at once, up only slowly and only while quiet: a room getting
// noisier raises the floor, but speech never does - otherwise a long, loud
// sentence would slowly become "quiet" and get cut off.
export function nextFloor(rms: number, floor: number, loud: boolean): number {
  if (rms < floor) return rms
  return loud ? floor : floor + (rms - floor) * 0.05
}

export function createEndpointer({
  initialFloor,
  alreadySpeaking = false,
  frameMs = 100,
  silenceMs = 1200,
  noSpeechMs = 6000,
  maxMs = 20_000,
}: EndpointOptions = {}) {
  let floor = initialFloor ?? Infinity
  let elapsed = 0
  let speechFrames = 0
  let heardSpeech = alreadySpeaking
  let quietMs = 0
  let loudest = 0
  return {
    push(rms: number): EndpointDecision {
      elapsed += frameMs
      loudest = Math.max(loudest, rms)
      const loud = isSpeech(rms, floor)
      floor = nextFloor(rms, floor, loud)
      if (loud) {
        speechFrames += 1
        quietMs = 0
        if (speechFrames >= MIN_SPEECH_FRAMES) heardSpeech = true
      } else {
        speechFrames = 0
        quietMs += frameMs
      }
      if (elapsed >= maxMs) return 'too-long'
      if (heardSpeech && quietMs >= silenceMs) return 'finished'
      if (!heardSpeech && elapsed >= noSpeechMs) return 'no-speech'
      return 'listening'
    },
    heardSpeech: () => heardSpeech,
    floor: () => floor,
    loudest: () => loudest,
  }
}

// Whether the end of some audio is speech, judged the same way push()
// does: the last few frames clearly above the quietest one.
export function endsInSpeech(levels: readonly number[], frames = 3): boolean {
  if (levels.length < frames) return false
  const floor = Math.min(...levels)
  return levels.slice(-frames).every(level => isSpeech(level, floor))
}

// Loudness of one frame: RMS around the frame's own average, not around
// zero. A mic with a DC offset (the simulator's sits at about +150 out of
// 32768 in silence [LAB-SIM]) otherwise reads as a constant "sound" that
// buries speech: there, a plain RMS put the room at 0.0042 and speech at
// barely 2x it. Real mics often have an offset too.
export function rmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let mean = 0
  for (let i = 0; i < samples.length; i++) mean += samples[i]
  mean /= samples.length
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += (samples[i] - mean) ** 2
  return Math.sqrt(sum / samples.length)
}
