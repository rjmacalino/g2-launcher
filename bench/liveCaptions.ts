import { readFileSync } from 'node:fs'
import { openLiveTranscriber } from '../src/core/liveTranscribe'
import { llmFromEnv } from './llmEnv'

// Streams a recording to Gemini Live in real time and prints the captions
// as they arrive (G2-134). Run: npx tsx bench/liveCaptions.ts bench/audio/x.wav
const file = process.argv[2] ?? 'bench/audio/leetcode-two-sum.wav'
const config = llmFromEnv()
if (!config || config.provider !== 'gemini') {
  console.log('Needs a Gemini key (bench/llmEnv.ts).')
  process.exit(1)
}
const wav = readFileSync(file)
// A plain 44-byte header; the audio is 16 kHz 16-bit mono.
const pcm = new Uint8Array(wav.buffer, wav.byteOffset + 44, wav.length - 44)
const began = Date.now()
const t = () => ((Date.now() - began) / 1000).toFixed(1)
const live = openLiveTranscriber(config.apiKey, {
  onInterim: text => console.log(`${t()}s interim: ${text}`),
  onFinal: text => console.log(`${t()}s FINAL:   ${text}`),
  onStatus: text => console.log(`${t()}s ${text}`),
})
await new Promise(r => setTimeout(r, 2500))
// 40 ms frames at real-time pace, like the glasses.
for (let at = 0; at < pcm.length; at += 1280) {
  live.push(pcm.subarray(at, at + 1280))
  await new Promise(r => setTimeout(r, 40))
}
// Two seconds of silence so the last words are finalised.
for (let i = 0; i < 50; i++) {
  live.push(new Uint8Array(1280))
  await new Promise(r => setTimeout(r, 40))
}
await new Promise(r => setTimeout(r, 3000))
live.close()
console.log(`audio was ${(pcm.length / 32000).toFixed(1)}s`)
process.exit(0)
