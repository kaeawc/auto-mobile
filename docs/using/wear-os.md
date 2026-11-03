# Wear OS emulators

AutoMobile can drive a Wear OS emulator with the same tools it uses on a phone. This guide covers
setting one up, the watch-specific behaviour, and what is out of scope.

> [!NOTE]
> **Verified on** a Wear OS 7.0 emulator (API 37 `android-wear-signed` image, `wearos_small_round`
> profile, 384x384). Other images, square watches and physical watches are unverified. Sleep/wake
> power-state changes have been measured; ambient mode itself has no usable readback.

## Create the emulator by hand

AutoMobile does not pick a watch for you: `provisionDevice` never chooses a Wear OS image for a
default Android device, and asking for `formFactor: "watch"` with `createIfMissing` fails with an
error. Create the AVD with the Android command-line tools, or pass `provisionDevice` an explicit
Wear OS `runtime` and `deviceType` (unverified).

```bash
# Pick a Wear OS system image. Use API 34 or newer; API 37 is the verified one.
sdkmanager --list | grep android-wear
sdkmanager "system-images;android-37.0;android-wear-signed;arm64-v8a"

# List device profiles and pick a round one.
avdmanager list device | grep -i wear

avdmanager create avd \
  --name wear-37-round \
  --package "system-images;android-37.0;android-wear-signed;arm64-v8a" \
  --device wearos_small_round

emulator -avd wear-37-round
```

The exact image and profile ids vary by SDK version and host architecture (use `x86_64` on an
Intel host); take them from `sdkmanager --list` and `avdmanager list device`.

AutoMobile classifies the emulator as `watch` from the system-image tag (`android-wear`) or a
`wear_`/`wearos_` profile id, so `formFactor: "watch"` appears in the device description and can
be asked for in a device `requires` clause. The device resources also report
`traits.formFactor: "watch"` when the build announces it in `ro.build.characteristics`.

## What to expect

A Wear OS image is an Android build, so the tools that need only adb and the accessibility tree
work unchanged. On the verified emulator:

| Tool                                    | Result                                                              |
| --------------------------------------- | ------------------------------------------------------------------- |
| `startDevice`, `listDevices`            | Pass: the emulator is adopted and reported as `formFactor: "watch"` |
| `observe`                               | Pass: view hierarchy, screenshot and `isScreenRound`                |
| `launchApp`, `terminateApp`, `listApps` | Pass                                                                |
| `tapOn`, `tapAt`                        | Pass, including rows at the bottom edge of a round screen           |
| `swipeOn`, `swipeOn` with `lookFor`     | Pass: touch drags scroll watch lists                                |
| `pressButton` `back`, `home`            | Pass (see below)                                                    |
| `rotaryScroll`                          | Pass (see below)                                                    |
| `performanceTrace`                      | Pass                                                                |
| `prototype` `show`, `dismiss`, `save`   | Pass (see below)                                                    |

The screen is small, and on a round display content near the corners is cut off. `swipeOn` with
`lookFor` scrolls until the element is visible and returns it; call `tapOn` to open it. On a round
watch list the centre of each row lies inside the visible circle, edge rows included, so the tap
lands.

- `observe` reports `isScreenRound` on a watch: `true` on a round display, `false` on a square one,
  absent when it cannot be read.
- `pressButton` `back` behaves like the Wear OS swipe-from-the-left-edge gesture: it closes the
  current screen, and repeated presses return to the watch face. `home` from inside an app returns
  to the watch face; from the watch face it opens the app list, which is the platform's own
  behaviour.

## Scrolling with the crown

`rotaryScroll` scrolls the way the watch crown does, which is how most watch lists and pickers
expect to move. It is not listed by default; enable it with `setToolEnabled` (see
[Dynamic Tools](dynamic-tools.md)).

```json
{ "name": "rotaryScroll", "arguments": { "delta": 3 } }
```

- `delta`: crown detents, a whole number from -50 to 50 and not 0. Positive scrolls content down.
- The tool tries `input rotaryencoder scroll`, then the emulator console, then a vertical swipe,
  and after each reads the screen back. `success` is `true` once one of them changed the screen;
  `method` names it and `attempts` lists every try.
- A list already at its end does not change, so it reports `success: false`.
- On a device that is not a Wear OS watch the input is still sent, and the result carries
  `warningCode: "not_watch"` and a `warning`: phones usually ignore rotary input, so use `swipeOn`
  for lists on this device or run the test on a Wear OS image such as `wearos_small_round`.

On the verified emulator `input rotaryencoder scroll` moves both plain and curved lists in either
direction, and the emulator-console attempt always fails; the swipe fallback covers images where
neither native method works. Check `attempts` on other images.

`swipeOn` with `lookFor` still scrolls with touch swipes on a watch, which is enough for the
system lists tested.

## Ambient power state

Enable `ambient` with `setToolEnabled` (see [Dynamic Tools](dynamic-tools.md)), then call:

```json
{ "name": "ambient", "arguments": { "action": "enter" } }
```

Use `action: "exit"` to wake the device. This Android-only tool sends `KEYCODE_SLEEP` for
`enter` or `KEYCODE_WAKEUP` for `exit`, then reads wakefulness once. `success: true` means
`Dozing` or `Asleep` for enter, or `Awake` for exit. A failed or unreadable state returns
`success: false` with a `reason`; inspect `wakefulness` when present and use `observe` to
check the current state.

This is a power-state change. Wear exposes no ambient readback, so the result does not prove
ambient mode. Hardware wake by tilt or touch remains untested. Command failures return an
error; check the device connection before retrying.

## Prototypes

`prototype` `show` renders on a watch with the phone overlay and components; there are no
watch-specific components or rotary input in a prototype. A successful `show` on a watch reports
`screenRound`, so you can tell why content in the corners is clipped. On a round display the
dismiss control and non-fullscreen windows are inset into the square inscribed in the circle, so
they stay tappable. Wear launchers are not expected to support pinned shortcuts, so `save` with
`pin: true` keeps the save and reports `pinned: "unsupported"`.

## Not supported

- Choosing or creating a Wear OS emulator from `formFactor` alone, and physical watches.
- Notifications, tiles, complications and watch faces (`systemTray` is built for the phone
  notification shade).
- Ambient-mode verification, hardware wake by tilt or touch, and a paired phone and watch.
- Watch-specific prototype components and round-aware prototype layout.
