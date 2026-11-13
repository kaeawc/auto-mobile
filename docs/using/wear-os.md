# Wear OS emulators

AutoMobile drives a Wear OS emulator with the same tools it uses on a phone. This guide covers
setup, watch-specific behaviour, and what is out of scope.

> [!NOTE]
> **Verified on** a Wear OS 7.0 emulator (API 37 `android-wear-signed` image, `wearos_small_round`
> profile, 384x384), including sleep/wake and the watch face's ambient state. Other images, square
> watches and physical watches are unverified.

## Create the emulator

Install a Wear OS system image, then ask for a watch and let AutoMobile create it:

```bash
# Use API 34 or newer; API 37 is the verified one.
sdkmanager "system-images;android-37.0;android-wear-signed;arm64-v8a"
```

```json
{ "platform": "android", "formFactor": "watch", "createIfMissing": true }
```

Pass that to `startDevice`. AutoMobile creates the AVD with the round `wearos_small_round` profile
from an installed image:

- Image tags in order of preference: `android-wear-signed`, `android-wear`, `android-wear-cn`.
- The newest API level in your `minOsVersion` / `maxOsVersion` range, with an ABI your machine can run.

A phone, tablet or foldable request never gets a Wear image. If no Wear image in the range is
installed, the error names the `sdkmanager` command to run; AutoMobile downloads nothing. Asking
again reuses the watch instead of creating another.

To pick the screen shape, add `requires.screenRound`:

```json
{
  "platform": "android",
  "formFactor": "watch",
  "createIfMissing": true,
  "requires": { "screenRound": false }
}
```

- `true` matches only a round profile, and `false` only a square one. AutoMobile skips an existing
  watch of the other shape and creates one with `wearos_small_round` or `wearos_square`.
- A watch whose profile names no shape never satisfies `screenRound`.
- Leave it out to accept any watch and create a round one.
- On anything but an Android watch request, `screenRound` fails without creating a device.

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

Image and profile ids vary by SDK version and host architecture (use `x86_64` on an Intel host).
Take them from `sdkmanager --list` and `avdmanager list device`.

AutoMobile classifies the emulator as `watch` from the system-image tag (`android-wear`) or a
`wear_`/`wearos_` profile id. The device description then shows `formFactor: "watch"`, and a device
`requires` clause can ask for it. The device resources also report `traits.formFactor: "watch"` when
the build announces it in `ro.build.characteristics`.

## What to expect

Tools that need only adb and the accessibility tree work unchanged. On the verified emulator:

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

The screen is small, and a round display cuts off content near the corners. Use `swipeOn` with
`lookFor` to scroll until the element is visible, then `tapOn` to open it. Taps on round watch
lists land, because each row's centre lies inside the visible circle, edge rows included.

- `observe` reports `isScreenRound` on a watch: `true` on a round display, `false` on a square one,
  absent when unreadable.
- `observe` also reports `surface` on a watch: `tile`, `watchface`, `launcher` or `app`. It is absent
  when AutoMobile cannot identify the surface, including the notification tray.
- `pressButton` `back` acts like the Wear OS swipe from the left edge. It closes the current screen,
  and repeated presses return to the watch face.
- `pressButton` `home` from inside an app returns to the watch face. From the watch face it opens
  the app list, as the platform does.

## Scrolling with the crown

`rotaryScroll` scrolls the way the watch crown does, which most watch lists and pickers expect.
Enable it with `setToolEnabled` (see [Dynamic Tools](dynamic-tools.md)).

```json
{ "name": "rotaryScroll", "arguments": { "delta": 3 } }
```

- `delta`: crown detents, a whole number from -50 to 50 and not 0. Positive scrolls content down.
- The tool tries `input rotaryencoder scroll`, then the emulator console, then a vertical swipe.
  It reads the screen back after each. `success` is `true` once one of them changed the screen.
  `method` names it and `attempts` lists every try.
- A list already at its end does not change, so it reports `success: false`.
- On a device that is not a Wear OS watch, AutoMobile still sends the input. The result carries
  `warningCode: "not_watch"` and a `warning`. Phones usually ignore rotary input, so use `swipeOn`
  there or run the test on a Wear OS image.

On the verified emulator, `input rotaryencoder scroll` moves plain and curved lists both ways, and
the console attempt always fails. Check `attempts` on other images. `swipeOn` with `lookFor` still
scrolls with touch swipes on a watch.

## Notifications

On a watch, `systemTray` drives the Wear OS notification stream instead of the phone shade. Before
opening the stream, AutoMobile dismisses any alert covering the watch with Back.

- `open` swipes the stream up from the bottom edge and reports `opened: true` once the stream is on
  screen.
- `close` goes back and reports `closed: true` only after the stream is gone.
- Both fail when the screen does not change. When the stream is already in the requested state,
  they succeed with `skipped: true`.

`list` and `clearAll` require `notification.appId`. `find`, `tap`, `dismiss`, `list` and `clearAll`
scroll the stream from its top. AutoMobile scrolls an already-open stream back to the top first and
leaves it open afterwards. If it cannot reach the top within `awaitTimeout`, the action fails with
`notification_not_found` instead of scanning from the middle. `list` instead returns no cards,
flagged as below.

- `list` returns each card once with its app label, `title`, `body`, `texts` and `bounds`. The `id`
  is `null` and `actions` is empty. Without `awaitTimeout` it scans for up to 30 s, enough for a
  typical stream.
- When a `list` scan stops early, it still succeeds with the cards read so far and
  `incomplete: true`. Its `incompleteReason` is `deadline` (time ran out), `page_limit` (too many
  pages) or `rewind` (the top was out of reach, so no cards). Retry with a larger `awaitTimeout` to read the rest.
- `tap` opens the card, then taps `tapActionLabel` (or the card's title or body) in the expanded
  card. It scrolls the stream when the action sits below the screen edge. If that text is not a
  single clickable target, it collapses the card and fails rather than guessing. Retry with an
  explicit `tapActionLabel`.
- `dismiss` swipes the card sideways, and taps the X button when the swipe only reveals it (Wear OS
  7). It reports `dismissal_unconfirmed` unless it confirms the removal. With `appId`, one of the
  app's active notifications with the card's title and body must go away. Otherwise one fewer such
  card must show. Of two identical cards, removing one counts.
- `clearAll` taps the stream's **Clear all** only when every active notification belongs to
  `appId`. Otherwise, or when `title` or `body` narrows it, it dismisses matching cards one by one.

### Inline replies

Set `notification.replyText` on `tap` to reply inline. The text must be a single word with no
whitespace; AutoMobile rejects multi-word text before typing anything. The reply then:

1. Defaults the action label to **Keyboard input**. An explicit `tapActionLabel` overrides it.
2. Types the text and commits it with the keyboard's **Space** key, so Gboard appends one trailing
   space.
3. Verifies the typed text, taps **Send**, and restores the stream.

If the text does not land, it retries a few times, then fails without sending. If the keyboard,
Space key or Send button is unavailable, re-observe and retry.

### Watch face and screen rules

The stream opens only from the watch face. Every action that opens it first leaves the app list
(with `back`) or an app in front (with `home`). It closes the stream back onto the watch face
afterwards.

- If the watch face does not come back, the action fails without the open gesture. Press the
  watch's side button and retry.
- If closing the stream after `dismiss` or `clearAll` leaves the app list in front, the action
  reports `dismissal_unconfirmed` with its `dismissedCount`. Press `back` to return to the watch
  face.
- AutoMobile refuses a tap target whose centre falls outside the round display. Scroll it into view.
- Every action captures the configured action screenshot or accessibility audit from the final
  screen, as on a phone.

## Ambient power state

Enable `ambient` with `setToolEnabled` (see [Dynamic Tools](dynamic-tools.md)), then call:

```json
{ "name": "ambient", "arguments": { "action": "enter" } }
```

Use `action: "exit"` to wake the device. On a watch, `enter` sends `KEYCODE_SLEEP` and `exit` sends
`KEYCODE_WAKEUP`. The tool then reads wakefulness and the watch face's ambient state once.

The tool runs only on a Wear OS watch. On a phone, tablet, TV or automotive device it returns an
error naming the form factor and changes nothing. When the device does not report its form factor,
AutoMobile accepts a session recorded as a watch and refuses any other. Check `formFactor` with
`listDevices`.

| Result field       | Value                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------- |
| `ambient`          | `true` or `false` as the watch face reports it, or `"unknown"` without watch-face state |
| `watchFaceVisible` | Whether the watch face is on screen, when `ambient` is known                            |
| `wakefulness`      | `Awake`, `Dozing` or `Asleep`, when readable                                            |
| `reason`           | Why the call failed, with `success: false`                                              |

| Action  | Succeeds when                                   | When `ambient` is `"unknown"` (does not prove ambient mode) |
| ------- | ----------------------------------------------- | ----------------------------------------------------------- |
| `enter` | `ambient` is `true`                             | wakefulness is `Dozing` or `Asleep`                         |
| `exit`  | `ambient` is `false` and wakefulness is `Awake` | wakefulness is `Awake`                                      |

- If `enter` leaves wakefulness `Awake`, a stay-awake setting (`svc power stayon true`) probably
  keeps the display on. Turn it off and retry.
- If `watchFaceVisible` is `false`, an app is in front of the watch face.
- For visual proof, take a screenshot after `enter`: the watch face renders dimmed in ambient.
- Command failures return an error. Check the device connection before retrying.

## Tiles, watch faces and complications

`wearSurface` adds, removes and shows tiles, reads and sets watch faces, and fills complication
slots. See [Wear OS tiles and watch faces](wear-os-watch-faces.md).

## Prototypes

`prototype` `show` renders on a watch with the phone overlay and components, without rotary input.
A successful `show` on a watch reports `screenRound`, which explains clipped corner content. On a
round display, AutoMobile insets the dismiss control and non-fullscreen windows into the square
inscribed in the circle, so they stay tappable. On a watch, `save` with `pin: true` keeps the save
and reports `pinned: "unsupported"`.

## Not supported

- Physical watches: only Wear OS emulators are matched and created.
- Listing the tiles in the carousel, and listing complication providers.
- Tapping a notification's expanded content or action buttons without a clickable label or
  `notification.replyText` (see [Notifications](#notifications)).
- Hardware wake by tilt or touch, and a paired phone and watch.
- Watch-specific prototype components and round-aware prototype layout.
