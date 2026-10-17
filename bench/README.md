# Jarvis benchmark

Measures how fast and how good Jarvis is, on the PC, without the glasses.
Each question in `questions.json` is spoken by the Windows voice, heard by
the app's own Whisper engine, answered by the app's own Gemini client and
prompt, then scored.

## Run it

```
npm run bench
npm run bench -- --only leetcode
npm run bench -- --only general-capital
npm run bench -- --no-gemini
```

`--only` takes a category or a question id. `--no-gemini` measures hearing
only.

## Gemini key

Gemini answers need your API key on this PC. Create a file named
`.env.local` in the project folder (it is gitignored, never committed)
with one line:

```
GEMINI_API_KEY=your-key-here
```

Without it, the run measures hearing only. A full run sends one request
per question (14 today) and waits 4 seconds between them to stay inside
the free tier's per-minute limit; set `BENCH_GEMINI_GAP_MS` to change that.

## Reading the output

- `hear`: Whisper time on this PC. A phone is usually slower; Lab's
  "Live transcription" probe measures the phone.
- `answer`: Gemini time, close to what the glasses see (same round trip).
- `WER`: word error rate of what Whisper heard. 0 is perfect.
- `PASS`/`FAIL`: the answer contains the expected words. `REVIEW` means
  there is nothing automatic to check (small talk, interview phrasing), so
  read the answer yourself.

Results are saved to `bench/results/` (gitignored) so runs can be compared.
Generated audio is cached in `bench/audio/`; delete a file to re-speak it
after editing its question.

## Adding questions

Add an entry to `questions.json`. Write numbers as words ("two thousand",
not "2000") in the spoken text, since Whisper may write either. `expect` is
a list of groups: every group must match, and a group matches if the answer
contains any one of its words. Personal questions are answered from the
made-up wearer in `persona.ts`, never real data.
