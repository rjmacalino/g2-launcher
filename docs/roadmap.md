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

- [x] 0.2 `app.json`: added the `network` permission with
      `https://api.open-meteo.com` in the whitelist (was missing, the likely
      cause of weather failures). `min_sdk_version` was already `0.0.15`
- [ ] 0.3 Adopt `@evenrealities/pretext`; replace hand-estimated sizes
      (the confirm list assumes 54 px per item, the documented value is 40 px)
- [x] 0.4 Restructured `src/` into the layout below. Verified with a real
      simulator session: menu, tool open/close, the confirm dialog and
      navigation all still fire correctly, and the build output is unchanged
- [x] 0.5 Tooling: ESLint (flat config, typescript-eslint, browser globals for
      `src/`, Node globals for `scripts/`), Prettier matching the existing
      no-semicolon style, Vitest with unit tests for the WMO condition
      mapping, the day/hour grouping in `fetchForecast`, and the notes
      checklist text sanitiser. GitHub Actions CI runs typecheck, lint,
      format check, test and build on every pull request and push to `main`
      (`npm run ci` reproduces the same sequence locally)

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

- [x] Image: canvas draw works (gradient, filled circle, filled square, all in
      one 288 x 144 send). Verified in the simulator via Lab's "Draw +
      long-press to clear" probe. Not yet tested at icon sizes (24 x 24,
      48 x 48) or as a data chart specifically, and not yet on real hardware
- [x] Image: all-black send clears a container. Verified in the simulator -
      draw, then long-press to send all-black to the same container, back to
      blank with no rebuild. Overturns the "cannot be cleared" premise behind
      page.ts's LEAVE-CONFIRM PROMPT history (see docs/platform.md, Image
      containers). Not yet confirmed on real hardware
- [x] Glyph sheet: renders in Lab's "Glyph sheet" probe, one line per
      candidate with its codepoint label, including a known-bad control
      (the weather sun glyph, already proven to fail). Ran once in the
      simulator - every candidate drew something there, which the simulator's
      own caveats say is not proof of hardware behaviour. Needs a real
      on-glasses run to mean anything
- [~] Text brightness levels 0 to 4. Lab's brightness probe sends a
      content-less, `textColor`-only update (the same shape previously
      verified on real hardware for the dimmed-modal design) and it was
      rejected (`false`) in the simulator. Likely a simulator gap, not a
      reversal - needs a real-hardware re-check to be sure either way
- [x] Contextual menu: custom items and their click events. Full round trip
      confirmed in the simulator - see docs/platform.md, Device APIs
- [~] List item height matches 40 px. Not independently re-measured; G2-37
      already applied this value from the documented source. No Lab probe
      built for it specifically - deferred rather than re-deriving a number
      the codebase already trusts
- [~] Partial `textContainerUpgrade` (`contentOffset`) and scroll position.
      Tried in the simulator and it did not look like a real partial
      update - see docs/platform.md, Text containers for the full result.
      Needs real hardware; the simulator result here should not be trusted
      either way
- [x] Glasses microphone: live level meter, `speakerRole`. Confirmed in the
      simulator - real streamed PCM frames, frame count and speakerRole both
      updated live in Lab's mic probe
- [~] Browser `SpeechRecognition` availability. Present in the desktop
      simulator's own WebView, but that is not the Even app's real WebView on
      a phone - still [UNVERIFIED] for the actual target environment
- [ ] IMU stream: head tilt values. `imuControl()` is an unimplemented
      variant in this simulator build, same failure as location - needs real
      hardware, nothing more to learn from the simulator here
- [ ] Album pick to glasses photo. `pickImageFromAlbum()` is also an
      unimplemented variant in this simulator build - needs real hardware
- [x] Device status: battery, `isWearing`. Confirmed in the simulator -
      `getDeviceInfo()`/`getUserInfo()` both resolve with the simulator's
      hardcoded values. Real values, and ring vs temple `eventSource`, still
      need hardware

## Phase 2: design system

- [x] Glasses tokens (`src/ui/tokens.ts`): brightness roles (primary 4,
      secondary 2, disabled 1) and icon size (24px). Layout geometry (margins,
      header height) already lives in platform/page.ts and was left there
      rather than duplicated under a second name - tokens.ts holds only what
      did not already have a home
- [x] Icon set: 6 weather condition icons (clear, cloudy, rain, snow, fog,
      storm), drawn as flat vector shapes at native 24 x 24 in
      `src/ui/icons.ts`, thresholded to pure black/white, sent as PNG via
      `updateImageRawData`. Verified in the simulator via Lab's "Icon set"
      probe - all 6 rendered and are legible at real size [LAB-SIM]. Timer,
      notes and battery icons not built yet - deferred until those features
      actually need them, rather than drawing icons with no consumer
- [ ] Page builders: header plus list, header plus text, full-image, confirm.
      Deliberately not done in this pass - this means touching main.ts's
      confirm dialog construction, which took six redesigns to get right (see
      page.ts's LEAVE-CONFIRM PROMPT history) and deserves a focused pass of
      its own with real hardware verification after, not a refactor bundled
      in alongside unrelated work
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
