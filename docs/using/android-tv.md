# Android TV emulators

AutoMobile can create, boot and drive an Android TV or Google TV emulator with the same device tools
it uses for a phone, plus D-pad focus navigation. This guide covers creating one, the lifecycle calls,
and what is out of scope.

> Use the `android-tv` image for TV apps. Touch gestures need a device with a touchscreen;
> otherwise, use D-pad navigation. AutoMobile treats every Android TV as having no touchscreen,
> including TV emulators, which report one although they have no touch input. A plain `tapOn` by
> `text` or `elementId` moves focus and presses `enter` for you; see [Navigating a TV app](#navigating-a-tv-app).

## Install a TV system image

AutoMobile never downloads system images. Install one first; use API 34 or newer.

```bash
sdkmanager --list | grep -E "android-tv|google-tv"
```

```bash
sdkmanager "system-images;android-36;android-tv;x86_64"
```

On an Apple silicon or other ARM host use `arm64-v8a` in place of `x86_64`. Not every API level
publishes every ABI; `sdkmanager --list` shows what exists.

## Create and start a TV emulator

Ask for a TV with `startDevice` and allow creation:

```bash
auto-mobile --cli startDevice --platform android --form-factor tv --create-if-missing
```

As an MCP call: `startDevice { platform: "android", formFactor: "tv", createIfMissing: true }`.
Creation must be allowed; see `AUTOMOBILE_ALLOW_DEVICE_CREATE` in
[Environment variables](environment-variables.md).

- Only installed `android-tv`, `google-tv` and `google-tv-ps16k` images are candidates. A phone,
  tablet, foldable or unspecified request never creates a TV, and a TV request never creates a phone.
- The newest API level in range wins, then an ABI the host can run, then the tag in the order above.
  AutoMobile prefers `android-tv` over `google-tv`: Google TV images ship the Play Store, which
  usually blocks `adb root`. The `android-tv` user build also refuses `adb root`; this
  preference does not guarantee root access.
- The AVD uses the `tv_1080p` hardware profile and is named `AutoMobile-android-tv-<api>-<id>`
  unless you pass `name`.
- `minOsVersion` and `maxOsVersion` narrow the API range as they do for a phone.
- With no TV image installed in range, the call fails with the exact `sdkmanager` command to run.
- A repeat request with `formFactor: "tv"` reuses the created AVD instead of creating another.

For another profile such as `tv_4k` or `tv_720p`, call `provisionDevice` with an explicit spec:

```json
{
  "device": {
    "platform": "android",
    "name": "tv-36-4k",
    "spec": {
      "runtime": "system-images;android-36;android-tv;x86_64",
      "deviceType": "tv_4k"
    }
  }
}
```

## Create the emulator by hand

The Android command-line tools work too:

```bash
avdmanager create avd \
  --name tv-36 \
  --package "system-images;android-36;android-tv;x86_64" \
  --device tv_1080p
```

```bash
emulator -avd tv-36
```

`avdmanager list device | grep -i tv` lists the TV profiles.

## How AutoMobile recognises a TV

A device is `tv` when its AVD uses a TV system image or a `tv_*` profile. Such a device then shows
`formFactor: "tv"` in `listDevices`, and you can ask for it in a device `requires` clause or a broker
`deviceFamily`. A booted device reports `tv` in `traits.formFactor`.

## Lifecycle

| Step       | Call                                                                              |
| ---------- | --------------------------------------------------------------------------------- |
| Detect     | `listDevices`                                                                     |
| Create     | `startDevice` with `formFactor: "tv"` and `createIfMissing`, or `provisionDevice` |
| Start/boot | `startDevice { platform: "android", formFactor: "tv" }`                           |
| Shut down  | `killDevice`                                                                      |
| Delete     | `deleteDevice`, or `avdmanager delete avd -n <name>`                              |

## Navigating a TV app

TV apps respond to focus, not touch. A TV session lists `focusNavigate` in `tools/list` without
`enableTools`. Other tools that are off by default, such as `executePlan`, stay off until you enable
them (see [Dynamic tools](dynamic-tools.md)).

- Use `focusNavigate` to move D-pad focus to an element.
- Use `sendKeys` with `enter` to activate the focused item, or pass `select: true` to `focusNavigate`
  to press `enter` once focus lands. The result's `selected` is `true` only when `enter` was pressed.
- Use `pressButton` for back, home and the remote's keys.

| Button                                                   | Sends                                  |
| -------------------------------------------------------- | -------------------------------------- |
| `up`, `down`, `left`, `right`, `select`                  | D-pad directions and D-pad center      |
| `playPause`, `fastForward`, `rewind`, `next`, `previous` | Media keys to the current media player |

The names match the Apple TV remote buttons; `fastForward`, `rewind`, `next` and `previous`
work only on Android.

For a long press of D-pad center, for example to open a context menu, pass `durationMs` with
`select`. `pressButton { button: "select", durationMs: 1000 }` holds the key for one second.

| `durationMs` rule | Value                                                     |
| ----------------- | --------------------------------------------------------- |
| Range             | 100 to 10000                                              |
| Buttons           | `select` only                                             |
| Android version   | API 35 or newer                                           |
| Otherwise         | The call fails with `unsupported_button` and sends no key |

### Exploring and replaying

`explore` walks a TV app the same way: it moves focus to each element and selects it. It records the
screens and transitions in the navigation graph, and `navigateTo` replays those steps with D-pad moves.
Both need the server to run with `--embedded-sdk` and the app to embed the AutoMobile SDK; see
[Navigation graph](navigation-graph.md#availability).

| Situation                            | Behavior                                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rows below the visible list          | `explore` presses down (or right along a rail) until a new row scrolls into view, up to 12 presses; it stops when focus stops moving or leaves the list |
| Card revealed in a rail              | Recorded as `focusNavigate` with `direction: "right"`; `navigateTo` presses right from wherever focus is, so it reaches the card only from that rail    |
| `explore { dryRun: true }`           | Lists planned steps as `tapOn` and `swipeOn` and returns `inputMode: "dpad"` (`"touch"` on a touch device)                                              |
| Running a planned `tapOn`            | Moves focus to the target and selects it                                                                                                                |
| Running a planned `swipeOn`          | Presses along the list                                                                                                                                  |
| `focusNavigate` with `select: false` | Records a transition only when the screen changes within 2 seconds of the call's start                                                                  |
| `focusNavigate` with `select: true`  | The 2 seconds count from the select press                                                                                                               |

A transition that a longer focus-only walk triggers is not recorded, so `navigateTo` cannot replay it.
A category rail that switches content when focused is one example.

### How focus matches a target

`focusNavigate` matches a target on the focused element or on a child label belonging to that
control, so a card with its title in a child view counts.

`observe` names such a card the same way. When the focused element has no text or content-desc of
its own, `focusedElement.descendantLabel` is its child label: the `label` of its `skeleton` row.

- The field is omitted for text fields, and when no `skeleton` row at the focused bounds carries a
  label shown by a child.
- A card with several child labels gets the row's first one. That can differ from the child label
  `focusNavigate` matched.
- A focused scrollable container does not count for a child target. Neither does a container
  holding the target inside another focusable or clickable control. Navigation continues until the
  control owns focus.
- To land on the exact control `tapOn` would tap, name the target with `until.label` or
  `until.elementId` alone. Focus must then reach that control; a focused row that only contains it
  does not count.

### Tapping on a TV

On a TV, `tapOn` with a `text` or `elementId` selector moves D-pad focus to the match and presses
`enter`. One flow can then tap on both Android TV and tvOS.

The selector picks the same element a touch tap would. That includes a text field found by its
placeholder, and the first of several matches even when focus is on another one. The result has
`inputMethod: "dpad"` and a `focusNavigation` object with the focus `status`, `steps` and `path`.

Focus takes the shortest route: it reaches a match on another row by changing rows first. With
`action: "longPress"` the call holds D-pad center for `duration` ms (default 1000) instead of
pressing `enter`. The hold needs Android 15 (API 35) or newer.

If focus cannot reach the match, the call fails without pressing `enter`. Observe and retry, or move
closer with `focusNavigate`.

A card may not be on screen yet, further along a row that only shows its first cards. The walk then
searches the row whose cards are labelled like it (`Trending card 1` to `5` for `Trending card 8`).
Focus moves into that row, presses right to its end, then left, and does not leave it. This applies
to `focusNavigate` too.

- If neither end holds the card, `status` is `stuck`. The message says the target was not on
  screen and names the row and the element focus ended on; check the label.
- When no row on screen is labelled like the target, the walk presses down instead, and the
  message says so.

A link inside text (`selector.accessibilityLink` or `subtext`) activates directly, without touch or
D-pad focus, so it works on a TV as on a phone.

### When focus is trapped

When an editable text field or the on-screen keyboard holds focus, the walk first hides a shown
keyboard with back. It presses tab when the focused element is not a text field, then tries every
direction again.

| Focused control                                 | What the walk does                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| Compose text field (keeps focus on every arrow) | Presses tab once and tries again                                                     |
| Classic View `EditText` (not inside Compose)    | Never presses tab, with or without a `resource-id`, since tab could type into it     |
| Control that takes arrows as values (a slider)  | Presses each arrow at most once; when none leaves it, presses tab once and continues |

If focus still does not move, `focusNavigation.status` is `stuck`. `focusNavigate` returns the same
fields.

| Field or message            | Content                                                             |
| --------------------------- | ------------------------------------------------------------------- |
| `focusNavigation.blockedBy` | `ime` or `editable`                                                 |
| `focusNavigation.escapes`   | Keys tried (`back`, `tab`)                                          |
| Error for a trapped field   | Names the field, the arrows that did not move focus, and what to do |
| Error for a value control   | Names the control and the arrows it consumed                        |

What to do next:

- **View field, all four arrows failed:** press `pressButton` `back` to leave the screen and reach
  the target from another route. If the keyboard was still shown, hide it with `back` and observe first.
- **View field, walk stopped early:** the walk can stop before trying every arrow, with a
  `direction` set or when the target is not on screen. The error then names the arrows not yet
  pressed; try those before leaving the screen.
- **Compose field:** hide the keyboard with `pressButton` `back`, then press `sendKeys` key `tab`.
- **Value control:** its value may have changed, so check it before continuing.

An IME action such as `sendKeys` key `next` or `done` does not move D-pad focus out of the field.

### What needs a touchscreen

On a TV, `tapOn` fails without tapping when you pass any of these, and the error names each one:

- Selectors `testTag` and `textAny`.
- Actions other than `tap` and `longPress`.
- Options `sibling`, `container`, `index`, `searchUntil`, `ensureChecked`, `layer`, `display`,
  `exactText`, and a `selectionStrategy` other than `first`.

Name the element with only `selector.text` or `selector.elementId` instead. Or move focus with
`focusNavigate` and press `pressButton` `select`. `swipeOn` needs a touchscreen too; on a TV without
one, navigate with `focusNavigate` and `sendKeys`.

### Prototype overlays

Prototype overlay buttons support D-pad navigation and show a visible outline when focused.
Use `focusNavigate` to reach a button and `sendKeys` with `enter` to activate it.
Use `prototype` with `dismiss` to close the overlay.

## Out of scope

- Physical TVs and Chromecast hardware.
- Casting.
- Downloading system images.
