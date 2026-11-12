# Headless prototypes

Headless mode lets the `prototype` tool run with no Android device, emulator or iOS simulator, for
example in CI, a container or a Linux sandbox. AutoMobile holds the prototype in memory on a
virtual device and you read it as a web page.

## Turn it on

Start AutoMobile with `--headless`, or set `AUTOMOBILE_HEADLESS=1` in its environment. Restart a
daemon that is already running so it picks the mode up. Headless mode is never chosen
automatically.

## What works

- `show`, `patch`, `dismiss`, `status`, `inspect` and `awaitEvent` take the same arguments as on a
  device.
- Mock backends (`defineBackend`, `mock`, `mockPath`), `screenMap`, `share` and test sessions.
- The accessibility findings a successful `show` or `patch` returns.
- `automobile:prototype/<id>/web` returns the prototype as one HTML page in a device frame, and
  `automobile:prototype/native?id=<id>` returns the files that embed it in an app.

Every result includes `virtualDevice`:

| Field                     | Meaning                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| `deviceId`                | `automobile-virtual-prototype`.                                      |
| `renderer`                | `web`: the prototype is drawn only by the web page, not on a screen. |
| `unsupportedCapabilities` | Device features the virtual device cannot emulate (see below).       |

## What is refused

- `save`, `listSaved`, `deleteSaved`, `open`, `clearStorage` and `simulate` fail with "needs a
  real device".
- `display` fails: there is one display.
- A spec that needs a capability in `unsupportedCapabilities` fails with the same error an older
  device gives, for example `window.persistence: "device"` or `window.layer: "app"`
  (`prototype_window_options_v1`), element anchors, `appearance: "light"`/`"dark"`, blur
  backdrops, custom shaders, dead taps, `via: "device"` requests, platform modules such as haptics
  and clipboard, storage and timers. Remove the feature, or run on a device.

Without `window.chrome`, a show reports `chrome: "bar"`, as on a device without
`prototype_window_chrome_v1`.

## Events

Nothing taps the virtual device yet: `awaitEvent` returns `timedOut: true` after `timeoutMs`
unless an event arrives. Taps in the web page run in the browser only.
