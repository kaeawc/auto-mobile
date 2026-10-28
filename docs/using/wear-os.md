# Wear OS emulators

AutoMobile can drive a Wear OS emulator with the same tools it uses on a phone. This guide covers
setting one up, the watch-specific behaviour, and what is out of scope.

> [!WARNING]
> **Not yet verified on a device.** The watch-specific behaviour below is built and unit tested
> against fakes. The baseline run on a real Wear OS emulator has not happened, so every
> behaviour that depends on the emulator is **unverified**.

## Create the emulator by hand

AutoMobile does not pick a watch for you: `provisionDevice` never chooses a Wear OS image for a
default Android device, and asking for `formFactor: "watch"` with `createIfMissing` fails with an
error. Create the AVD with the Android command-line tools, or pass `provisionDevice` an explicit
Wear OS `runtime` and `deviceType` (unverified).

```bash
# Pick a Wear OS system image. Use API 34 or newer.
sdkmanager --list | grep android-wear
sdkmanager "system-images;android-34;android-wear;x86_64"

# List device profiles and pick a round one.
avdmanager list device | grep -i wear

avdmanager create avd \
  --name wear-34-round \
  --package "system-images;android-34;android-wear;x86_64" \
  --device wearos_large_round

emulator -avd wear-34-round
```

The exact image and profile ids vary by SDK version; take them from `sdkmanager --list` and
`avdmanager list device`.

AutoMobile classifies the emulator as `watch` from the system-image tag (`android-wear`) and the
profile id, so `formFactor: "watch"` appears in the device description and can be asked for in a
device `requires` clause. The device resources also report `traits.formFactor: "watch"` when the
build announces it in `ro.build.characteristics`.

## What to expect

A Wear OS image is an Android build, so the tools that need only adb and the accessibility tree
(`observe`, `tapOn`, `swipeOn`, `pressButton`, `launchApp`, screenshots) are expected to work
unchanged. The screen is small, and on a round display content near the corners is cut off.

- `observe` reports `isScreenRound` on a watch: `true` on a round display, `false` on a square one,
  absent when it cannot be read.
- Back on Wear OS is a swipe from the left edge. Whether `pressButton` `back` and `home` behave like
  that gesture and return to the watch face is unverified.

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
- On a device that does not announce a watch build the input is still sent, and the result carries
  a `warning`, since most phones ignore rotary input.

Which of the three methods works on a given image is unverified; check `attempts`.

`swipeOn` with `lookFor` still scrolls with touch swipes on a watch.

## Prototypes

`prototype` `show` renders on a watch with the phone overlay and components; there are no
watch-specific components or rotary input in a prototype. A successful `show` on a watch reports
`screenRound`, so you can tell why content in the corners is clipped. Wear launchers are not
expected to support pinned shortcuts, so `save` with `pin: true` keeps the save and reports
`pinned: "unsupported"`.

## Not supported

- Choosing or creating a Wear OS emulator from `formFactor` alone, and physical watches.
- Notifications, tiles, complications and watch faces (`systemTray` is built for the phone
  notification shade).
- Ambient mode, and a paired phone and watch.
- Watch-specific prototype components and round-aware prototype layout.
