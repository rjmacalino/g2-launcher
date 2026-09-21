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

## Getting set up

```bash
npm install
