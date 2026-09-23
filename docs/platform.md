# G2 platform reference

What the Even Realities G2 and Even Hub SDK can and cannot do, collected from
official documentation, well-maintained community references, and our own
hardware tests. Every entry carries a source tag so it can be re-checked.

Researched 2026-09-24 against SDK 0.0.15, simulator 0.9.5, CLI 0.1.14.

Source tags:

- [SDK] `node_modules/@evenrealities/even_hub_sdk/README.md` and `dist/index.d.ts` (v0.0.15)
- [DOCS] https://hub.evenrealities.com/docs (official)
- [TPL] https://github.com/even-realities/evenhub-templates (official starters)
- [PLUGIN] https://github.com/even-realities/everything-evenhub (official developer kit)
- [SIM] `node_modules/@evenrealities/evenhub-simulator/README.md`
- [NOTES] https://github.com/nickustinov/even-g2-notes (community reference, widely cited)
- [COMMUNITY] a named open-source G2 project, linked where cited
- [HW] our own test on RJ's glasses, recorded in this repo's history
- [UNVERIFIED] claimed somewhere, not yet tested by us

## 1. Hardware

| Fact | Source |
|---|---|
| 576 x 288 px canvas per eye, origin top-left | [DOCS] |
| 4-bit greyscale (16 levels), shown as green. Black pixels are off, which reads as transparent | [DOCS] |
| Four-microphone array, audio delivered as 16 kHz PCM | [DOCS] |
| No speaker, no audio output, no glasses-side camera | [DOCS] device-apis "Unsupported" list |
| Input: press, double press, swipe up/down, long press, release. Temples and the R1 ring share one gesture set | [DOCS] |
| Events carry `eventSource`: right temple, ring, left temple (long press, SDK 0.0.15) | [SDK] |
| Code runs in a WebView on the phone. Glasses only render and send input over BLE | [DOCS] architecture |

## 2. Page and containers

| Rule | Source |
|---|---|
| Max 4 image containers and 8 text/list containers per page, `containerTotalNum` 1 to 12 | [DOCS] [SDK] |
| Exactly one container has `isEventCapture: 1` | [DOCS] |
| `containerName` max 16 characters, unique per page | [DOCS] |
| `zOrderIndex`: all containers on a page or none, unique values, larger draws in front | [SDK] |
| Border (text and list only): `borderWidth` 0 to 5, `borderColor` 0 to 15, `borderRadius` 0 to 10, `paddingLength` 0 to 32 | [DOCS] |
| No background fill, no alignment, no font choice, no font size, no animation API, no programmatic scroll position | [DOCS] |
| Contextual menu (`menuObject`): up to 10 items, labels max 32 UTF-8 bytes, opened by the user with tap then long press. Rebuilding without `menuObject` clears it | [DOCS] contextual-menu |

### Text containers

| Rule | Source |
|---|---|
| Content limit 1000 chars on create/rebuild, 2000 on `textContainerUpgrade` | [DOCS] |
| About 400 to 500 characters fill the full screen | [DOCS] |
| `textColor` brightness 0 to 4 (default 4). Level 0 may be invisible | [DOCS] [SDK] |
| Line height 27 px | [PLUGIN] font-measurement, matches our own measurement [HW] |
| Font is proportional, not monospaced. Pixel-accurate measuring: `@evenrealities/pretext` (`getTextWidth`, `measureTextWrap`, `pxTruncate`) | [PLUGIN] |
| Padding and border shrink the text area on all four sides | [PLUGIN] |
| `textContainerUpgrade` supports `contentOffset` and `contentLength` for partial replacement | [DOCS] |
| Any content-carrying upgrade or rebuild resets the firmware scroll position. A brightness-only upgrade does not | [HW] |

### Glyphs

Characters missing from the firmware font are silently dropped, not shown as a
box [DOCS]. We confirmed this on hardware: U+2600, U+2601, U+2614, U+2744 and
U+26A1 rendered as nothing [HW].

Reported as available [NOTES], useful for UI (all as `\uXXXX` escapes in source):

- Lines: U+2500, U+2501 (thin, thick horizontal), U+2502 (vertical)
- Rounded corners: U+256D to U+2570
- Bars: U+2581 to U+2588 (lower blocks), U+2589 to U+258F (left blocks), U+2592 (shade)
- Shapes: U+25A0/U+25A1 (squares), U+25CF/U+25CB (circles), U+25B2, U+25B6, U+25BC, U+25C0 (triangles), U+25CE (bullseye)
- Stars: U+2605, U+2606. Degree sign U+00B0. Arrows U+2190 to U+2199
- Missing: most Misc Symbols (all weather symbols), Dingbats, all emoji, Misc Technical (clock and timer symbols)

The official design guide lists the same working subset [DOCS]. We have not yet
run this table on our own glasses.

### List containers

| Rule | Source |
|---|---|
| Up to 20 items, 64 characters each | [DOCS] |
| Item height 40 px fixed, 12 px horizontal padding per side | [PLUGIN] font-measurement |
| Items render vertically centred in the list box | [HW] |
| No per-item styling, no separators, no in-place update (rebuild required) | [DOCS] |
| Firmware owns scroll and highlight. A rebuilt list always highlights index 0 | [DOCS] [HW] |
| The first item's `currentSelectItemIndex` can arrive missing (zero elision) | [NOTES] [HW] |

### Image containers

| Rule | Source |
|---|---|
| Size 20 to 288 wide, 20 to 144 high | [DOCS] [SDK] |
| Data: encoded image bytes (PNG, JPEG) or raw greyscale. The host decodes, resizes and converts to 4-bit | [TPL] image template, [SIM] 0.9.2 to 0.9.3 |
| Canvas works: draw on an offscreen `<canvas>`, `toBlob('image/png')`, send the bytes | [TPL] |
| Cannot send during `createStartUpPageContainer`. Create, then call `updateImageRawData` | [DOCS] |
| Never send two images at once. Await each send | [DOCS] |
| Match image size to the container, a smaller image is tiled | [NOTES] |
| Black pixels are off, so an all-black image effectively clears a container | [DOCS] [NOTES] [UNVERIFIED by us] |
| Image-first pages: full-screen text container with `' '` and `isEventCapture: 1` behind the image | [DOCS] |
| Photos from the phone: `pickImageFromAlbum()` / `captureImageFromCamera()` return base64 (permissions `album`, `camera`) | [SDK] [DOCS] |
| Store icons: 1-bit, built from 2 x 2 pixel blocks, strokes at least 2 px. In-app icons: 24 x 24 is the norm | [DOCS] design-guidelines |

### Performance (one measured data point, SDK 0.0.13)

Per-call cost dominates, payload size barely matters [NOTES]:

| Call | Cost |
|---|---|
| `updateImageRawData` | about 104 ms fixed plus about 3.9 ms per KB |
| `rebuildPageContainer` | about 165 ms flat |
| `textContainerUpgrade` | about 83 ms per call |

Consequences: animate one large image rather than several small ones (ceiling
about 9 fps); rebuild instead of upgrading three or more containers; never await
location or network before the first paint.

## 3. Device APIs

| API | Permission name in `app.json` | Source |
|---|---|---|
| Network (`fetch`, WebSocket) | `network` with a `whitelist` of full origins. Whitelist does not bypass CORS | [DOCS] networking |
| Location one-shot and continuous | `location` | [DOCS] |
| Glasses microphone | `g2-microphone` (page must exist before `audioControl`) | [DOCS] [TPL] |
| Phone microphone | `phone-microphone` | [DOCS] |
| Album / camera | `album` / `camera` | [DOCS] |
| IMU (x, y, z via `sysEvent.imuData`, pacing P100 to P1000) | none listed | [SDK] |
| Device status: battery, charging, `isWearing`, in case | none | [SDK] |
| User info: name, avatar, country | none | [SDK] |
| Launch source: `appMenu` or `glassesMenu` | none | [SDK] |

Audio format: PCM 16 kHz, signed 16-bit little-endian, mono, 100 ms per event
[SIM] [DOCS]. Each frame also carries `speakerRole` (self, other, unknown).

### Speech to text

There is no speech-to-text in the SDK [TPL] "STT provider is a blank stub".
Community apps solve it three ways:

1. Cloud STT (Deepgram, Soniox, AssemblyAI, Whisper) behind a small proxy that
   holds the API key, for example a Cloudflare Worker. About 1 s latency for
   short commands [COMMUNITY] https://github.com/tntpsu/even-voice-shim
2. Browser `SpeechRecognition` in the WebView, which uses the phone microphone,
   not the glasses one. [COMMUNITY] https://github.com/MrScautHD/Even-Voice-AI
   uses it as its primary path. [UNVERIFIED] on our phone.
3. Self-hosted Whisper on a machine we control.

Keys must never ship in the package, it is extractable [DOCS].

## 4. Lifecycle and background

| Fact | Source |
|---|---|
| Root page double tap must call `shutDownPageContainer(1)` | [DOCS] |
| iOS keeps the WebView alive in background. Android may kill it, so treat resume like a cold start | [DOCS] |
| Timers are not guaranteed to keep running in background. Store an end timestamp, compute remaining time from the clock | [DOCS] background-lifecycle |
| Audio capture and location stop in background and must be re-armed on foreground | [DOCS] |
| QA locks the phone for 5 minutes and expects a running Timer to still be correct | [DOCS] app-submission |
| There is no push or scheduled alert API. Alerts only show while our app is open, unless a native phone app schedules OS notifications, which the Even app mirrors to the glasses | [COMMUNITY] https://github.com/aleapc/even-hub-devguide (docs/mobile-companion.md) |

## 5. Submission rules that affect design

From [DOCS] app-submission:

- `name` max 20 characters, must not contain "Even"
- `min_sdk_version` at least `0.0.14`
- Every declared permission must be used, and have a `desc` of 1 to 300 characters
- First run must never show a black screen. Setup that needs input explains itself on the glasses
- Core flow must work with glasses and ring input alone, phone locked

## 6. Tooling we should use instead of rebuilding

| Tool | What it replaces | Source |
|---|---|---|
| `everything-evenhub` developer kit | guessing SDK behaviour | [PLUGIN] |
| `@evenrealities/pretext` | our hand-measured row heights and character widths | [PLUGIN] |
| Simulator automation API (`--automation-port`): screenshots, console, input | manual clicking to check layouts | [SIM] |
| evenhub-templates `image` renderer | our own image pipeline | [TPL] |

## 7. Reference apps worth reading

From https://github.com/pangoleen/awesome-even-realities-g2:

- weather-even-g2: Open-Meteo, no backend, canvas-rendered weather icons, one module per screen
- stt-even-g2, even-voice-shim: speech to text patterns
- Visionote: photos on the glasses with greyscale conversion
- even-simple-timer, Even-R-Clock, My Pomodoro: timers and alarms
- even-toolkit: design system, 191 pixel-art icons, STT module
