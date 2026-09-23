# Roadmap

Plan agreed direction as of 2026-09-24. Facts behind each item live in
[platform.md](platform.md). Status markers: `[ ]` not started, `[~]` in
progress, `[x]` done, `[?]` waiting on a decision.

## Principles

1. Use what exists before building. Official docs, `@evenrealities/pretext`,
   the official templates and the simulator automation API come first.
2. Verify, then build. Anything marked [UNVERIFIED] in platform.md gets a
   probe on the simulator, then on hardware, before a feature depends on it.
3. Glasses first. Every flow must work with ring or temple input, phone locked.
4. Time and state survive suspension. Persist to storage, derive from
   timestamps, never trust a running interval.

## Phase 0: foundations (no user-visible features)

- [ ] 0.2 `app.json`: add the `network` permission with
      `https://api.open-meteo.com` in the whitelist (currently missing, a likely
      cause of weather failures), raise `min_sdk_version` to `0.0.15`
- [ ] 0.3 Adopt `@evenrealities/pretext`; replace hand-estimated sizes
      (the confirm list assumes 54 px per item, the documented value is 40 px)
- [ ] 0.4 Restructure `src/` into the layout below
- [ ] 0.5 Tooling: ESLint, Prettier, Vitest for pure logic, GitHub Actions CI
      running typecheck, lint, test and build on every pull request

### Target structure

```
src/
  app/            shell: bootstrap, navigation, input dispatch
  platform/       SDK adapters only: bridge, storage, page, image, audio,
                  location, imu, device status
  ui/             glasses design system: layout tokens, brightness levels,
                  glyph constants, icon bitmaps, reusable page builders
  features/
    weather/      api, service, glasses views, companion views
    notes/
    teleprompter/
    timer/
  companion/      phone page shell and shared phone components
  shared/         pure helpers with no SDK access (time, formatting)
tests/            unit tests for pure logic
docs/             platform.md, roadmap.md, decisions/
```

Rule of thumb: `features/*` may import `ui`, `platform`, `shared`. `platform`
imports only the SDK. `shared` imports nothing from the project.

## Phase 1: capability lab (probes)

A dev-only "Lab" tool, excluded from release builds, one menu item per probe.
Each probe gets run on the simulator (screenshots via the automation API),
then on hardware by RJ. Results go back into platform.md with a [HW] tag.

- [ ] Image: canvas-drawn 24 x 24 and 48 x 48 icons, a 288 x 144 chart
- [ ] Image: all-black send clears a container
- [ ] Glyph sheet: every character platform.md lists as available
- [ ] Text brightness levels 0 to 4 side by side
- [ ] Contextual menu: custom items and their click events
- [ ] List item height matches 40 px
- [ ] Partial `textContainerUpgrade` (`contentOffset`) and scroll position
- [ ] Glasses microphone: live level meter, `speakerRole`
- [ ] Browser `SpeechRecognition` availability inside the Even app WebView
- [ ] IMU stream: head tilt values
- [ ] Album pick to glasses photo
- [ ] Device status: battery, `isWearing`; ring vs temple `eventSource`

## Phase 2: design system

- [ ] Glasses tokens: margins, header height, brightness roles
      (primary 4, secondary 2, disabled 1), glyph constants
- [ ] Icon set: weather conditions, timer, notes, battery; 24 x 24, 1-bit,
      2 px strokes, rendered to PNG and sent via one image container per page
- [ ] Page builders: header plus list, header plus text, full-image, confirm
- [ ] Companion page follows the Even phone design tokens (from the official
      design guidelines)

## Phase 3: features

- [ ] Status bar: condition icon, battery, active timer
- [ ] Weather v2: icons, hourly temperature chart as an image
- [ ] Timer: hour and minute pickers, runs from an end timestamp, shows on the
      status bar while other tools are open, contextual menu for pause/cancel
- [ ] Alarm: visual only (no speaker), only while the app is open
- [ ] Voice notes: dictate a checklist item
- [ ] Voice commands: "set a timer for 5 minutes", parsed on our side
- [ ] Photo viewer: album image on the glasses

## Decisions

- D1 Speech to text (2026-09-24): no paid services for now. Free options, in
  the order we will try them:
  1. Browser `SpeechRecognition` in the WebView (phone mic). Needs the Phase 1
     probe; support inside the Even app WebView is unverified.
  2. Whisper running in the WebView itself (WASM). Glasses mic, no server, but
     a large model download and slow on a phone. Unverified.
  3. Whisper on RJ's own computer, reached over the local network. Free, but
     only works while that machine is on.
  Paid cloud STT stays out unless this decision is revisited.
- D2 Alarms (2026-09-24): visual only, while the app is open. No native phone
  companion for now.
