import { isSpeech, nextFloor } from '../../shared/endpoint'

// Cuts Wingman's continuous mic stream into utterances (G2-65): a
// segment starts when speech starts and ends at the next real pause, so
// each one is a sentence or so that Whisper can transcribe on its own.
// Silence is never sent to Whisper at all - in a quiet room Live costs
// almost nothing, which matters with the mic on for a whole conversation.
// Pure: fed one 100 ms frame and its loudness at a time.
//
// The pause length trades lag for completeness: shorter cuts sentences in
// half at a breath, longer means the transcript (and later, the cues)
// arrives later. A long monologue is cut every MAX_SEGMENT_MS anyway, so
// one never waits on a speaker who does not pause.

export type Segment = {
  frames: Uint8Array[]
  // The glasses' own guess at who spoke most of this segment: "self",
  // "other" or "unknown" (see core/mic.ts).
  speaker: string
  endedAt: number
}

export type SegmenterOptions = {
  frameMs?: number
  pauseMs?: number
  maxSegmentMs?: number
  // Frames kept from just before speech was detected, so a segment does
  // not start mid-word.
  leadInFrames?: number
  // Loud frames in a row before it counts as speech.
  minSpeechFrames?: number
  // How far above the room's quiet level counts as speech. Lower than the
  // 2x a "Hey Jarvis" recording uses to decide it has ended: Live has to
  // catch the other person too, who is further from the glasses' mic than
  // the wearer, and Whisper plus the hallucination filter tidy up any noise
  // that gets through. [LAB-SIM: speech through the PC's speakers peaked at
  // 1.9x the room.]
  speechRatio?: number
}

export function createSegmenter({
  frameMs = 100,
  pauseMs = 700,
  maxSegmentMs = 12_000,
  leadInFrames = 3,
  minSpeechFrames = 2,
  speechRatio = 1.5,
}: SegmenterOptions = {}) {
  let floor = Infinity
  let leadIn: { pcm: Uint8Array; speaker: string }[] = []
  let current: { pcm: Uint8Array; speaker: string }[] | null = null
  let loudStreak = 0
  let quietMs = 0

  function finish(at: number): Segment {
    const frames = current ?? []
    current = null
    quietMs = 0
    const counts = new Map<string, number>()
    for (const f of frames) counts.set(f.speaker, (counts.get(f.speaker) ?? 0) + 1)
    let speaker = 'unknown'
    let best = 0
    for (const [role, count] of counts) {
      if (count > best) {
        best = count
        speaker = role
      }
    }
    return { frames: frames.map(f => f.pcm), speaker, endedAt: at }
  }

  return {
    // Returns a finished segment when this frame completes one.
    push(pcm: Uint8Array, rms: number, speaker: string, now: number): Segment | null {
      const loud = isSpeech(rms, floor, speechRatio)
      floor = nextFloor(rms, floor, loud)
      const frame = { pcm, speaker }

      if (!current) {
        loudStreak = loud ? loudStreak + 1 : 0
        leadIn.push(frame)
        if (leadIn.length > leadInFrames + minSpeechFrames) leadIn.shift()
        if (loudStreak < minSpeechFrames) return null
        current = leadIn
        leadIn = []
        loudStreak = 0
        quietMs = 0
        return null
      }

      current.push(frame)
      quietMs = loud ? 0 : quietMs + frameMs
      if (quietMs >= pauseMs) return finish(now)
      if (current.length * frameMs >= maxSegmentMs) {
        const segment = finish(now)
        // Still talking: carry straight on into the next segment.
        current = []
        return segment
      }
      return null
    },
    // The room's quiet level and whether speech is being heard right now,
    // for the Live screen's level readout.
    level: () => ({ floor: Number.isFinite(floor) ? floor : 0, speaking: current !== null }),
    // Whatever was being said when Live stopped.
    flush(now: number): Segment | null {
      return current && current.length > 0 ? finish(now) : null
    },
  }
}
