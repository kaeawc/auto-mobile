# Wear OS emulators

AutoMobile can drive a Wear OS emulator with the same tools it uses on a phone. This guide covers
setting one up, the watch-specific behaviour, and what is out of scope.

> [!NOTE]
> **Verified on** a Wear OS 7.0 emulator (API 37 `android-wear-signed` image, `wearos_small_round`
> profile, 384x384). Other images, square watches and physical watches are unverified. Sleep/wake
> power-state changes have been measured; ambient mode itself has no usable readback.

## Create the emulator

Install a Wear OS system image, then ask for a watch and let AutoMobile create it:

```bash
# Use API 34 or newer; API 37 is the verified one.
sdkmanager "system-images;android-37.0;android-wear-signed;arm64-v8a"
```

```json
{ "platform": "android", "formFactor": "watch", "createIfMissing": true }
```

Pass that to `startDevice`. AutoMobile picks only from installed `android-wear-signed`,
`android-wear` and `android-wear-cn` images (in that order, newest API level in your
`minOsVersion` / `maxOsVersion` range, an ABI your machine can run) and creates the AVD with the
round `wearos_small_round` profile. A phone, tablet or foldable request never gets a Wear image. If
no Wear image is installed in the range, the error names the `sdkmanager` command to run; nothing is
downloaded. Asking again reuses the watch instead of creating another.

To pick the screen shape, add `requires.screenRound`:

```json
{
  "platform": "android",
  "formFactor": "watch",
  "createIfMissing": true,
  "requires": { "screenRound": false }
}
```

`true` matches only a watch whose profile is round and `false` only a square one, so an existing
watch of the other shape is not reused; a new watch is created with `wearos_small_round` or
`wearos_square`. A watch whose profile names no shape never satisfies `screenRound`. Leave it out to
accept any watch and create a round one. `screenRound` on anything but an Android watch request
fails without creating a device. Square watches are unverified.

You can still create the AVD by hand:

```bash
# List device profiles and pick one.
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

## Notifications

On a watch, `systemTray` drives the Wear OS notification stream instead of the phone shade:
`open` swipes the stream up from the bottom edge and `close` goes back. `list` and `clearAll`
require `notification.appId`; `find`, `tap`, `dismiss`, `list` and `clearAll` scroll the stream
from its top, and an already-open stream is scrolled back to the top first and left open
afterwards. If the top cannot be reached within `awaitTimeout`, the action fails with
`notification_not_found` instead of scanning from the middle.

- `list` returns each card's app label, `title`, `body`, `texts` and `bounds`; `id` is `null`
  and `actions` is empty.
- `tap` opens the card, then taps `tapActionLabel` (or the card's title or body) in the expanded
  view. If that text is not a single clickable target there, it fails rather than guessing and
  goes back to the stream; retry with an explicit `tapActionLabel`.
- `dismiss` swipes the card sideways and reports `dismissal_unconfirmed` unless the removal is
  confirmed: with `appId`, by one of the app's active notifications showing the card's title
  and body going away; otherwise by one fewer such card being shown. Of two identical cards,
  removing one counts as a dismissal.
- `clearAll` taps the stream's **Clear all** only when every active notification belongs to
  `appId`; otherwise, or when `title` or `body` narrows it, it dismisses matching cards one by
  one.

A tap target whose centre falls outside the round display is refused; scroll it into view.
Every action captures the configured action screenshot or accessibility audit from the final
screen, as on a phone.

## Ambient power state

Enable `ambient` with `setToolEnabled` (see [Dynamic Tools](dynamic-tools.md)), then call:

```json
{ "name": "ambient", "arguments": { "action": "enter" } }
```

Use `action: "exit"` to wake the device. This tool runs only on a Wear OS watch: on any other
form factor (phone, tablet, TV, automotive) it returns an error naming the form factor and
changes nothing. A session recorded as a watch is trusted when the device does not report its
form factor; otherwise it is refused too, so check the device with `listDevices` (`formFactor`).
On a watch it sends `KEYCODE_SLEEP` for `enter` or `KEYCODE_WAKEUP` for `exit`, then reads
wakefulness once. `success: true` means `Dozing` or `Asleep` for enter, or `Awake` for exit. A
failed or unreadable state returns `success: false` with a `reason`; inspect `wakefulness` when
present and use `observe` to check the current state.

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

- Physical watches: only Wear OS emulators are matched and created.
- Tiles, complications and watch faces.
- Tapping a notification's expanded content or its reply and action buttons without an explicit
  clickable label (see [Notifications](#notifications)).
- Ambient-mode verification, hardware wake by tilt or touch, and a paired phone and watch.
- Watch-specific prototype components and round-aware prototype layout.
