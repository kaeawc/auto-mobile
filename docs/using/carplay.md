# CarPlay on iOS simulators

AutoMobile cannot observe or record the CarPlay screen yet. What works today is tapping it at
coordinates, and reading the templates your app shows on CarPlay, and acting on them, through the
AutoMobile iOS SDK in a Debug build. Head-unit buttons and the knob can be sent, but whether CarPlay
reacts to them is not confirmed yet. This page covers those paths and what is not supported.

## What works today

- iOS simulators only, with a Debug build of your app that includes the AutoMobile SDK.
- `GET /carplay/templates` on the SDK's HTTP server: the template stack your app shows on CarPlay,
  as JSON.
- `POST /carplay/action`: select a list row, image-row element, alert action or tab, go back, or
  pop to the root template.
- `startDevice` with `carPlay: {}` turns on the CarPlay screen of an iOS 26.x simulator without
  the Simulator window. See [Turn on the CarPlay screen with `startDevice`](#turn-on-the-carplay-screen-with-startdevice).
- `tapAt` with `display: "carPlay"` taps that screen. See
  [Tap the CarPlay screen](#tap-the-carplay-screen).
- `pressButton` with `display: "carPlay"` sends back, home, Siri and knob input to that screen. Not
  yet confirmed to act; see [Press head-unit buttons and turn the knob](#press-head-unit-buttons-and-turn-the-knob).
- The `carPlay` device resource setting turns CarPlay vehicle connectivity off on a simulator. See
  [Configuring device resources](../how-it-works/device-resources-configuring.md).

No MCP tool reads the template tree or sends these actions. `observe`, screenshots and
`videoRecording` capture the phone screen only.

## Open the CarPlay window

In Simulator, choose **I/O > External Displays > CarPlay**. A booted simulator lists the CarPlay
screen even while this window is closed, so the listing does not mean the screen is showing.
AutoMobile does not open or close the window for you; to turn the screen on without it, use
`startDevice` as below.

## Turn on the CarPlay screen with `startDevice`

An iPhone simulator can show its CarPlay screen with no Simulator.app window. Ask for it with
`startDevice`.

### Requirements

- An iPhone simulator on an iOS 26.x runtime from Xcode 26.x. Apple does not support CarPlay on the
  iOS 27 Simulator.
- Two local executables, named by environment variables on the daemon:
  - `AUTOMOBILE_CARPLAY_POWER_HELPER_PATH`: the carplay-power-helper, which turns on the CarPlay
    screen.
  - `AUTOMOBILE_CARPLAY_PROJECTION_PROBE_PATH`: the CarPlay projection probe, which confirms the
    screen is the car display. Use an absolute path.

### Request it

Pass `carPlay: {}` to `startDevice` for an iPhone simulator:

```json
{
  "platform": "ios",
  "deviceId": "<simulator UDID>",
  "carPlay": {}
}
```

Once the simulator is ready and bound to your session, AutoMobile turns on its CarPlay screen and
checks that the simulator now reports it as the car display. The response gains a `carPlay` block:

| Field            | Description                                                   |
| ---------------- | ------------------------------------------------------------- |
| `display`        | The car display's identity, for example `Car[2]`.             |
| `displayId`      | The simulator screen id of the car display.                   |
| `headUnitInputs` | `true` when you asked for head-unit inputs; absent otherwise. |

By default the car has a touch screen only. Pass `"carPlay": { "headUnitInputs": true }` to also
give it a back button, a home button and a knob, which
[`pressButton`](#press-head-unit-buttons-and-turn-the-knob) needs.

The simulator forgets the CarPlay screen whenever it boots, including after `killDevice` or when a
released device is reset. Pass `carPlay: {}` on each `startDevice` call that needs it; asking again
on a simulator that already shows CarPlay is harmless.

### Errors

| Error                                                                                                            | What to do                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `carPlay needs an iOS iPhone simulator`                                                                          | Use `platform: "ios"`. Android phones use [Android Auto](android-auto.md).                                                                                                                                                      |
| `[unsupported-runtime] Headless CarPlay needs an iOS 26.x runtime ...`                                           | The simulator runs iOS 27 or later. Create an iOS 26.x simulator with Xcode 26.x and request it there.                                                                                                                          |
| A message asking you to set `AUTOMOBILE_CARPLAY_POWER_HELPER_PATH` or `AUTOMOBILE_CARPLAY_PROJECTION_PROBE_PATH` | Build the executable, set the variable for the daemon, restart the daemon and retry.                                                                                                                                            |
| `... is ready and bound to session ..., but its CarPlay display is not available`                                | The simulator stays ready and held by your session. The rest of the message says what failed. Fix it and call `startDevice` again, or release the device. If the screen is not the car display, reboot the simulator and retry. |

## Tap the CarPlay screen

Once `startDevice` has turned on the CarPlay screen, tap it with `tapAt` and `display: "carPlay"`.
On that screen, `x` and `y` are pixels, since the CarPlay screen is 800x480 with the origin at the
top left:

```json
{
  "deviceId": "<simulator UDID>",
  "display": "carPlay",
  "x": 558,
  "y": 80
}
```

It needs the same simulator and the same two executables as `startDevice` with `carPlay`. AutoMobile
first checks that the CarPlay screen is the car display, then sends one touch down and up. The
response gives the point and a `carPlay` block with `display`, `displayId`, `width` and `height`. It
reports the tap that was sent, not what changed on the screen.

Only a plain tap at `x` and `y` works there: `image`, `coordinateSpace` other than `absolute`,
`action` other than `tap`, `durationMs`, `snapshotId`, `pointer` and `layer` are refused.

| Error                                                               | What to do                                                                                    |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `... is attached but not projecting ...` or `No CarPlay screen ...` | Call `startDevice` with `carPlay: {}` on this simulator, then retry. No touch was sent.       |
| `[carplay-not-powered] ...`                                         | The CarPlay screen is off, for example after a reboot. Call `startDevice` with `carPlay: {}`. |
| `[unsupported-runtime] ...`                                         | CarPlay taps need an iOS 26.x simulator.                                                      |
| `[usage] Tap point ... is outside ...`                              | Use a point inside the CarPlay screen's width and height.                                     |
| `[hid-failed] ...`                                                  | The simulator refused the touch. Reboot it, request `carPlay` again and retry.                |

## Press head-unit buttons and turn the knob

AutoMobile has not yet confirmed that CarPlay reacts to these inputs on a simulator. Each call
reports the input it sent, not what changed on the screen. Check the effect with
[`GET /carplay/templates`](#read-the-templates) before relying on one.

Call `startDevice` with `"carPlay": { "headUnitInputs": true }` first, then `pressButton` with
`display: "carPlay"`:

```json
{
  "deviceId": "<simulator UDID>",
  "display": "carPlay",
  "button": "rotary_rotate_cw",
  "steps": 2
}
```

| `button`                                                                          | Sends                                    |
| --------------------------------------------------------------------------------- | ---------------------------------------- |
| `back`                                                                            | The car's back button.                   |
| `home`                                                                            | The car's home button.                   |
| `siri`                                                                            | The car's voice button. Only works here. |
| `rotary_select`                                                                   | A knob press.                            |
| `rotary_nudge_up`, `rotary_nudge_down`, `rotary_nudge_left`, `rotary_nudge_right` | A knob nudge in that direction.          |
| `rotary_rotate_cw`, `rotary_rotate_ccw`                                           | Knob turns; `steps` is 1 to 50 detents.  |

`siri` does not need `headUnitInputs`; the other buttons do. Every other button, `durationMs`, and
`steps` on anything but a turn are refused. The response has `button` and a `carPlay` block with
`display`, `displayId`, `input` (the name sent, such as `knob-cw`) and `count`.

| Error                                                               | What to do                                                                                                                  |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `[head-unit-inputs-disabled] ...`                                   | The CarPlay screen was turned on without head-unit inputs. Call `startDevice` with `"carPlay": { "headUnitInputs": true }`. |
| `... is attached but not projecting ...` or `No CarPlay screen ...` | Call `startDevice` with `carPlay` on this simulator, then retry. No input was sent.                                         |
| `[carplay-not-powered] ...`                                         | The CarPlay screen is off, for example after a reboot. Call `startDevice` with `carPlay` again.                             |
| `[unsupported-runtime] ...`                                         | Head-unit inputs need an iOS 26.x simulator.                                                                                |
| `[hid-failed] ...`                                                  | The simulator refused the input. Reboot it, request `carPlay` again and retry.                                              |
| `pressButton siri is a CarPlay head-unit button ...`                | Pass `display: "carPlay"`. Phones, Android and tvOS do not take `siri`.                                                     |

## Register your CarPlay scene

Call `AutoMobileSDK.shared.initialize()` early in your app's launch; it starts the SDK's HTTP
server. Then call `registerCarPlay` when your CarPlay scene connects, passing the interface controller it
receives, and `unregisterCarPlay` when the scene disconnects:

```swift
AutoMobileSDK.shared.registerCarPlay(interfaceController: interfaceController)
AutoMobileSDK.shared.unregisterCarPlay()
```

Registration does nothing in a Release build. Your app still needs its own CarPlay entitlement and
scene configuration; the SDK does not add them. For how the SDK reads the templates, see
[CarPlay templates and actions](../how-it-works/plat/ios/carplay-template-snapshot.md).

## Read the templates

The SDK serves the routes on port 8766 on the host, as long as no other simulator holds that port.
It also listens on a port between 40000 and 40999 chosen from the simulator's UDID. When several
simulators are booted, 8766 may belong to another app: find your app's port with
`lsof -nP -iTCP -sTCP:LISTEN` and use it in place of 8766.

Set `UDID` to your simulator's UDID, from `xcrun simctl list devices booted`. With the
`X-AutoMobile-Simulator-UDID` header, a different simulator's app refuses the request with HTTP 409
`wrong_simulator`. Without the header, the request reaches whichever app holds the port, so stop
when `UDID` is empty:

```bash
: "${UDID:?Set UDID to the target simulator UDID}"
curl -s -H "X-AutoMobile-Simulator-UDID: $UDID" http://127.0.0.1:8766/carplay/templates
```

Both `GET /carplay/templates` and `POST /carplay/action` answer while your app is in the
background, because CarPlay can stay active then. The simulator identity check still applies to
both.

| Field       | Meaning                                                                   |
| ----------- | ------------------------------------------------------------------------- |
| `enabled`   | The app has called `registerCarPlay`. It stays true after unregistering.  |
| `connected` | The registered controller is still alive.                                 |
| `templates` | The controller's stack, bottom to top. Empty before registration.         |
| `presented` | The presented template, such as an alert or action sheet, when one is up. |
| `truncated` | Some nodes were left out because a size limit was reached.                |

Each node has an `id` and a `type`: `list`, `grid`, `tabBar`, `information`, `alert`,
`actionSheet`, `pointOfInterest`, `map`, `contact`, `voiceControl`, `nowPlaying`, `search` or
`unknown` (with `className`). Lists carry sections and rows with text, detail text, `enabled` and
`hasImage`; grids carry title variants; tab bars carry the selected tab and each tab's template.
Images are never included. The tree describes the templates your app set, not the pixels CarPlay
drew.

A snapshot holds at most 50 items in any collection, 500 nodes and 6 levels. IDs are paths such as
`stack/0/sections/1/items/0` or `stack/0/tabs/1`. They name positions in the current snapshot only:
after any change to the templates, including reordered rows, an old ID can name a different element.
Read a fresh snapshot before each action.

## Act on a template

```bash
curl -s -X POST -H "X-AutoMobile-Simulator-UDID: $UDID" \
  -d '{"id": "stack/0/sections/0/items/0", "action": "select"}' \
  http://127.0.0.1:8766/carplay/action
```

`action` is `select` (the default), `back` or `popToRoot`; only `select` needs an `id`. A valid
request returns HTTP 200 with `status`, an optional `reason` and the full `templates` snapshot taken
after the action. If your app updates its templates later, for example after a network call, read
the templates again.

| `status`      | Meaning                                                                                      | What to do                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `ok`          | The handler ran, the tab was selected, or the stack was popped.                              | Check the returned `templates`.                                                                         |
| `not_found`   | No node has that `id` in the current templates, or the node is past a size limit.            | Read the templates again and use a fresh `id`. If `truncated` is true, the element may be out of reach. |
| `failed`      | The element is disabled, a list row has no handler, or the pop failed.                       | Enable the element or add a handler.                                                                    |
| `unsupported` | The app has not registered, the controller is gone, or the node has no public selection API. | See `reason`.                                                                                           |

Grid buttons, bar buttons and text buttons return `unsupported`: CarPlay gives no public way to
trigger their handlers from outside. Malformed JSON, an unknown `action`, or `select` without an
`id` returns HTTP 400 `bad_request`.

## Not supported

| Not supported                                       | Why                                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| CarPlay screenshots, `observe` and `videoRecording` | No capture surface is available yet; CarPlay screen captures time out or come back black.                           |
| CarPlay in the device list                          | Device listings do not report a CarPlay screen yet.                                                                 |
| `tapOn`, swiping or typing on the CarPlay screen    | Only `tapAt` reaches it, at coordinates. Use `POST /carplay/action` for template actions.                           |
| Confirmed head-unit buttons and knob                | `pressButton` sends them, but no simulator run has shown CarPlay acting on them yet.                                |
| Long presses of head-unit buttons                   | Each button is a single press; `durationMs` is refused.                                                             |
| Physical iPhones, cars and head units               | Only simulators are supported.                                                                                      |
| Apple's CarPlay Simulator app                       | AutoMobile does not connect to it. Use the CarPlay window in Simulator.                                             |
| CarPlay prototypes                                  | Prototypes draw only on the phone screen. See [CarPlay prototypes](../how-it-works/plat/ios/carplay-prototypes.md). |
| Release builds                                      | The SDK routes and registration exist only in Debug builds.                                                         |
