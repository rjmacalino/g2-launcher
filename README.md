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

Events arrive through `bridge.onEvenHubEvent`. Two separate envelopes:

- `event.sysEvent` carries taps, double taps, and lifecycle events
- `event.textEvent` carries scroll gestures

Do not mix them up. Also note the protobuf gotcha documented in `src/main.ts`:
`CLICK_EVENT` is `0`, and zero values are omitted on the wire, so a plain tap
arrives with `eventType` undefined. The default has to be resolved inside the
envelope check or every unrelated event fires the tap handler.

Always check `DOUBLE_CLICK_EVENT` before `CLICK_EVENT`.

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

## Where this is going

The plan is one launcher app that opens into a menu of small tools (weather, GPS,
notes, teleprompter). Because the contextual menu is owned by the glasses OS and
only holds quick actions, the launcher menu has to be ours: a list container of
tool names, with our own state handling that calls `rebuildPageContainer` to swap
between the menu screen and each tool screen.

Keep it simple until it needs to be otherwise.

## Docs

- Overview and architecture: https://hub.evenrealities.com/docs
- Device APIs: https://hub.evenrealities.com/docs/build/device-apis
- Display system: https://hub.evenrealities.com/docs/build/display
- Templates: https://github.com/even-realities/evenhub-templates
