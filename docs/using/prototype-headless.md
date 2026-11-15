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
  device. `tapOn` and `sendKeys` act on the shown prototype (see [Events](#events)).
- Mock backends (`defineBackend`, `mock`, `mockPath`), `screenMap`, `share` and test sessions.
- The accessibility findings a successful `show` or `patch` returns.
- `automobile:prototype/<id>/web` returns the prototype as one HTML page in a device frame (see
  [Prototype web preview](prototype-web-preview.md)), and
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
  device gives. Examples: `window.persistence: "device"` or `window.layer: "app"`
  (`prototype_window_options_v1`), element anchors, `appearance: "light"`/`"dark"`, blur
  backdrops, custom shaders, dead taps, `via: "device"` requests, platform modules such as haptics
  and clipboard, storage and timers. Remove the feature, or run on a device.

Without `window.chrome`, a show reports `chrome: "bar"`, as on a device without
`prototype_window_chrome_v1`.

## Events

`tapOn` and `sendKeys` act on the shown prototype, so `awaitEvent` returns their events as it does
on a device.

- `tapOn` takes a `text`, `textAny`, `elementId` or `testTag` selector (`elementId` and `testTag`
  match a node's `id` or `testTag`). It taps the first visible node that matches. Hidden nodes,
  closed dialogs and sheets, other pager pages and stack screens below the top cannot be tapped.
  A tap on a node goes to the nearest enclosing node that handles taps. Switches, checkboxes and
  chips toggle their state key, and a dialog's confirm and dismiss buttons close it.
- `sendKeys` with `type` and `clear` commands writes to the `textField` or `searchBar` that a
  `tapOn` focused, or that its `selector` names. `maxLength` is applied.
- The result lists `events` (`sequence`, `kind`, `name`) and `virtualDevice`. `handled: false`
  means the tap reached nothing that handles it, or the control is disabled.

These actions run on a tap: `emit` (context from `state`, `page`, `data` or `value`),
`setState`, `toggle`, `increment`, `decrement`, `setPage`, `push`, `pop`, `popToRoot`, `replace`,
`dismiss` and `hideKeyboard`. A tap whose actions include anything else fails with "cannot run",
and nothing changes. That includes `request`, data actions, `platform`, timers, `emit` with
`requireValid`, and stacks with `routes` or route params. Run those on a device.

Not supported in headless mode:

- `tapOn` with `sibling`, `container`, `index`, `subtext`, `ensureChecked`, `display`, a
  non-default `selectionStrategy`, an `accessibilityLink` selector, or an `action` other than tap.
- `sendKeys` `key` commands.
- Nodes inside `repeat` templates.
- `tapAt` and screenshots: there is no rendered layout to tap or capture. Read
  `automobile:prototype/<id>/web` to see the page.

Taps in the web page itself change only the page.
