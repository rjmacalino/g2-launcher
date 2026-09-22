# G2 Launcher

An Even Hub app for Even Realities G2 smart glasses.

## How this actually works

This is the part that trips people up coming from normal web dev, so read it before
touching code.

Your code does **not** run on the glasses. There are three layers:

1. **Phone.** The Even Realities app hosts your built web app in a WebView. All of
   your JavaScript runs here.
2. **Glasses.** They render UI containers and send input events back over Bluetooth.
   No app logic runs here.
3. **Cloud.** Even Hub Cloud handles distribution once you ship.

So the HTML and CSS in `index.html` are never seen on the glasses. That page is just
the companion surface on the phone. Everything the wearer sees is described through
the SDK bridge instead.

## The display

- 576 x 288 px per eye, monochrome green, 16 brightness levels
- Origin is top left, x increases right, y increases down
- No arbitrary drawing, no background fills, no font sizes

You place **containers** at absolute pixel coordinates. Three kinds:

| Container | Limits |
| --- | --- |
| Text | left aligned only, 1000 chars on create, 2000 on update, brightness 0 to 4 |
| List | native scrollable list, max 20 items x 64 chars, firmware owns the highlight |
| Image | max 288 x 144, monochrome, sent after page creation via `updateImageRawData` |

Max 8 non-image containers plus 4 image containers per page. Exactly one container
must set `isEventCapture: 1`, and that is the one that receives input.

## Page lifecycle

| Call | When to use it |
| --- | --- |
| `createStartUpPageContainer` | once, at startup, defines the first screen |
| `rebuildPageContainer` | full redraw, use when the layout structure changes, flickers |
| `textContainerUpgrade` | in place text change, no flicker, same layout |
| `updateImageRawData` | push new image bytes into an existing image container |
| `shutDownPageContainer(1)` | exit, mode 1 shows the system confirm dialog |

`shutDownPageContainer(1)` on the root page is required. Submission QA checks that
the system exit dialog appears, and a custom in-app exit screen gets the app
rejected.

## Input events

Events arrive through `bridge.onEvenHubEvent`. Three envelopes:

- `event.sysEvent` carries taps, double taps, and lifecycle events
- `event.textEvent` carries scroll gestures and clicks on text containers
- `event.listEvent` carries list item events (highlight and click). This is the
  envelope the launcher menu runs on.

Do not mix them up. Also note the protobuf gotcha documented in `src/main.ts`:
`CLICK_EVENT` is `0`, and zero values are omitted on the wire, so a plain tap
arrives with `eventType` undefined. The default has to be resolved inside the
envelope check or every unrelated event fires the tap handler.

Always check `DOUBLE_CLICK_EVENT` before `CLICK_EVENT`.

## Gestures

This is the app's main behavioural contract. The event handler in `src/main.ts` is
the implementation; this table is what it is implementing.

| Gesture | Menu (root) | Tool page |
| --- | --- | --- |
| Tap | open the highlighted tool | free, the tool decides, currently unused |
| Double tap | `shutDownPageContainer(1)`, **required** | back to the menu |
| Long press | free, unassigned | free, unassigned |
| Tap then long press | OS native menu, never bind this | OS native menu, never bind this |

Three things are load-bearing here.

**Root double tap must exit.** Submission QA rejects apps that exit silently or do
nothing on root double tap, and it rejects a custom in-app confirmation. Mode `1` is
the only acceptable call. Relying on the OS menu's Close instead is explicitly
insufficient.

**The double-tap branch runs before everything else** in the handler, so nothing
below it can swallow the one gesture that guarantees the wearer can leave. Its else
branch covers anything that is not a confirmed tool page, not the menu specifically,
so a screen variant added later defaults to escapable rather than stranded.

**Tap then long press belongs to the glasses OS.** It raises the system overlay,
which always offers Close. Plain long press is ours and is deliberately unassigned.
An earlier version of this project assumed the opposite based on simulator
behaviour; hardware disagreed.

## Backgrounding and resume

Android may suspend the WebView under memory pressure and the module re-runs on
resume. iOS generally keeps it alive. The docs are blunt about it: treat Android
suspend as the app starting cold.

Two consequences, both handled in `src/main.ts`:

- **Location updates stop when suspended and do not restart themselves.**
  `FOREGROUND_ENTER_EVENT` re-arms GPS by tearing down and starting again, and
  resets the display to `Acquiring location...` first. Silently refreshing the
  numbers would leave a stale fix looking identical to a live one.
- **In-memory state does not survive a cold start.** The open page and the
  teleprompter position are both persisted. The page is restored only if it was
  stored within the last 30 minutes, so a resume lands where you left off but a
  relaunch the next day lands on the menu.

Anything awaited between page creation and event handler registration needs a
timeout. On that stretch the menu is already drawn, so a host call that never
settles leaves a healthy-looking app that responds to nothing, including root
double tap.

Testing note: on a high-RAM phone the documented 5-minute lock test may not trigger
suspension at all, because there is no memory pressure to cause it. Force-stopping
the host app produces the same cold start from this code's point of view and is the
more reliable trigger. Verified on a Samsung S23 Ultra.

## Getting set up

```bash
npm install
```

## Running it

Two terminals.

```bash
npm run dev        # terminal 1, Vite on port 5173
npm run simulate   # terminal 2, opens the simulator against it
```

The simulator draws the green 576 x 288 canvas, so you do not need the glasses to
start building.

To run on real hardware, find your machine's LAN IP, then:

```bash
npx evenhub qr --url "http://<YOUR-LAN-IP>:5173"
```

Scan that from the Even Realities app using **Scan QR**. Hot reload works.

## Page creation in the simulator and browser

Page creation can report code 1 (invalid) in two environments:

| Environment | First load |
|---|---|
| Real glasses via QR sideload | works, no failure |
| Simulator | may report code 1 |
| Plain browser at localhost:5173 | may report code 1 |

**Hardware is the source of truth for page creation.** The payload is valid. It succeeds on glasses. In the simulator, the VM is likely not ready to accept a page when the first call lands; on a plain browser there is no host at all, so a rejection is the correct answer.

The failure is non-deterministic. It has been observed on first load and on refresh, in both directions across runs, so do not expect a guaranteed reproduction.

Do not "fix" this by adding a retry or suppressing the message. That is the exact shape of change that risks working code on hardware to quiet a diagnostic in an environment where failure is expected. The diagnostic has been softened to reflect this. See the message in `src/main.ts`.

The pattern across this project is consistent: whenever the simulator and the hardware disagree, hardware decides. It has now happened across gesture ownership, the exit confirmation dialog, storage persistence, and permissions. See issue #11 for the full write-up.

## Shipping

```bash
npm run pack
```

That runs a typecheck, builds to `dist/`, and packs a `.ehpk` for the dev portal.

Never bundle API keys. A released package can be extracted by anyone, so any third
party credential has to sit behind a server side proxy.

## Manifest

`app.json` is the only Even specific config file. Fields worth knowing:

- `package_id` reverse DNS, lowercase, at least two segments
- `edition` must be `"202601"`
- `name` max 20 characters
- `min_sdk_version` should match the SDK you build against
- `permissions` array of `{ name, desc }`, valid names are `network`, `location`,
  `g2-microphone`, `phone-microphone`, `album`, `camera`

`min_app_version` is derived from the SDK at pack time, so it is left out here on
purpose.

## Where this is

One launcher app that opens into a menu of small tools. Because the contextual menu
is owned by the glasses OS and only holds quick actions, the launcher menu is ours:
a list container of tool names, with our own state handling calling
`rebuildPageContainer` to swap between the menu and each tool page.

| Tool | State |
| --- | --- |
| Teleprompter | built. Scroll to advance, position persisted across restarts |
| GPS | built. Live coordinates, re-arms on foreground, degrades to `Location unavailable` |
| Weather | not started. Needs a server side proxy, see below |
| Notes | not started. Needs a text input surface, and the glasses have no keyboard |

**Weather is blocked on infrastructure, not on the glasses.** A released `.ehpk` can
be extracted by anyone, so a weather API key physically cannot ship inside the app.
It needs a proxy we control, which is the point where this project grows a backend
and a container to run it in.

**Notes is blocked on a design question.** There is no keyboard. Text has to come
from the phone companion page, from dictation through `audioControl`, or from
somewhere else entirely. That choice shapes the whole tool, so it wants deciding
before any code.

There is no plugin system and no tool registry. Two tools with behaviour share a
named constant and a guarded branch each. If a third one makes those branches look
alike, that is the signal to factor. Not before.

Keep it simple until it needs to be otherwise.

## Docs

- Overview and architecture: https://hub.evenrealities.com/docs
- Device APIs: https://hub.evenrealities.com/docs/build/device-apis
- Display system: https://hub.evenrealities.com/docs/build/display
- Templates: https://github.com/even-realities/evenhub-templates

