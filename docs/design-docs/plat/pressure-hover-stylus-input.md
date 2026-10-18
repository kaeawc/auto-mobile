# Pressure, hover and stylus input

AutoMobile injects finger touches. It cannot yet drive stylus-only drawing modes,
pressure-sensitive brushes, palm rejection, hover previews, Apple Pencil
interactions or force-press menus. This note records what each platform's
injection path can carry, recommends an API shape, and lists the follow-up work
(#12539).

It is a research note, not a design for a shipped tool. Nothing here was run on an
emulator, simulator or device: the capability claims are read from source or
documentation, and every claim that needs a device is marked **unverified** and
carried into the [verification plan](#verification-plan).

## Evidence levels

| Label          | Meaning                                                                                 |
| -------------- | --------------------------------------------------------------------------------------- |
| **Source**     | Read from the platform source or header quoted below.                                   |
| **Reported**   | Described by a third party (forum, tracker); not reproduced here.                       |
| **Unverified** | Plausible from the above, but needs a run on a device or emulator before relying on it. |

## Android

### What CtrlProxy can carry today: fingers only

CtrlProxy dispatches every tap, swipe, drag and pinch through
`AccessibilityService.dispatchGesture` (`CtrlProxy.kt`: `performTapCoordinates`,
`performSwipe`, `performDrag`, `performPinch`, and the streaming
`StrokeDescription` coordinator).

**Source:** `GestureDescription` carries no input-device data. A stroke is a `Path`
with a start time and duration. The internal `TouchPoint` has only a stroke id,
continuation id, start/end-of-path flags and `x`/`y`. There is no field for tool
type, pressure, tilt, button state or hover, so no change inside CtrlProxy's
accessibility dispatch can produce a stylus event. The only per-gesture knob beyond
geometry and timing is the target display (`Builder.setDisplayId`, API 30).

### `adb shell input`: stylus tool type, fixed pressure, no hover

**Source:** `InputShellCommand` (AOSP `main`,
`services/core/java/com/android/server/input/InputShellCommand.java`):

- The shell sources include `stylus`, `mouse`, `touchscreen`, `touchpad` and others.
  The tool type is derived from the source: `stylus` gives `TOOL_TYPE_STYLUS`
  (as does the Bluetooth stylus source, which the shell does not name); `mouse`
  gives `TOOL_TYPE_MOUSE`; touch sources give `TOOL_TYPE_FINGER`.
- `tap`, `swipe`, `draganddrop` and `motionevent <DOWN|UP|MOVE|CANCEL> x y` accept a
  source prefix (`input stylus swipe ...`) and a `-d DISPLAY_ID`.
- The injected axes are `X`, `Y` and `PRESSURE` only. Pressure is a constant: `1.0`
  for `DOWN` and `MOVE`, `0.0` for `UP`. There is no way to pass tilt, orientation,
  distance, a button state (stylus barrel button) or an eraser tool type. The
  `--axis` option exists for `scroll` only.
- `motionevent` takes no `HOVER_*` action, so hover cannot be injected this way.

It runs as the shell user, so it needs neither root nor an installed helper. **Not
checked:** which releases have each command and source. Only `main` was read;
`motionevent` and the source prefix should be confirmed against the lowest API level
AutoMobile supports before depending on them.

So `adb shell input` can produce a _binary_ stylus (stylus tool type, full pressure
for the whole stroke). It cannot produce a pressure curve, tilt, an eraser or hover.

### Routes to richer input

| Route                                             | Pressure curve             | Tilt / buttons / eraser | Hover           | Needs                                                                  |
| ------------------------------------------------- | -------------------------- | ----------------------- | --------------- | ---------------------------------------------------------------------- |
| Accessibility `dispatchGesture` (today)           | No (**Source**)            | No (**Source**)         | No              | Accessibility service                                                  |
| `adb shell input stylus ...`                      | No, fixed 1.0 (**Source**) | No (**Source**)         | No (**Source**) | `adb` only                                                             |
| Virtual stylus through `uinput` (kernel evdev)    | **Unverified**             | **Unverified**          | **Unverified**  | `/dev/uinput` write access; likely root or an emulator/userdebug image |
| Emulator console `event send` raw evdev           | **Unverified**             | **Unverified**          | **Unverified**  | Emulator only                                                          |
| `Instrumentation` in-process `MotionEvent` inject | **Unverified**             | **Unverified**          | **Unverified**  | Instrumented app, own process only                                     |

The `uinput` and emulator-console rows are expected to work because both inject at
the evdev layer, where pressure, tilt and `BTN_TOOL_PEN` hover are ordinary axes and
keys; that is a hypothesis, not a finding. In-process instrumentation cannot reach
other apps' windows, so it does not fit AutoMobile's black-box model.

Whether the emulator exposes a stylus-capable input device to apps (an
`InputDevice` with `SOURCE_STYLUS`) depends on the AVD hardware profile and is
**unverified**.

### What the recorder sees

`recordDeviceGestures` reads kernel events with `getevent`. The reconstruction
(`TouchFrameReconstructor.ts`) keeps position and `ABS_MT_PRESSURE` per slot, and
nothing else: it ignores `ABS_MT_TOOL_TYPE`, `BTN_TOOL_PEN`, `BTN_STYLUS`,
`ABS_TILT_X`/`ABS_TILT_Y`, and `ABS_DISTANCE`/`ABS_MT_DISTANCE` (hover distance). The pressure it
keeps is not used by the gesture classifier. A recorded stylus stroke is therefore
exported as an ordinary finger swipe, and hover is invisible.

Two structural limits sit underneath that, and extending the axes alone does not
remove them (**Source**):

- **One event node.** `TouchNodeDiscovery.ts` selects only a node that exposes
  `ABS_MT_POSITION_X`/`ABS_MT_POSITION_Y`, and `GetEventReader` reads only that node.
  A pen that reports through a separate tablet-style node, commonly with `ABS_X`/`ABS_Y`
  plus `BTN_TOOL_PEN` and `BTN_TOUCH`, is never seen.
- **No drag event.** `GestureEventType` has no drag, and `DualTrackRecorder` maps a
  moving single-contact gesture to `swipeAt` or `swipeOn`, which keep only the
  endpoints. A drawn stroke loses its path.

## iOS

### What the runner can carry today: touches only

**Source:** CtrlProxy already drives private `XCPointerEventPath` /
`XCSynthesizedEventRecord` for pinch and multi-finger swipe
(`ObjCExceptionCatcher.m`), guarded by selector probes so a missing symbol is
reported as an availability gap, not a crash. Its own declaration of
`XCPointerEventPath` (`ObjCExceptionCatcher.h`) exposes only touch initialization,
`moveToPoint:atOffset:` and `liftUpAtOffset:`. The pressure and mouse selectors below
come from the header of the WebDriverAgent fork of those private classes
(`PrivateHeaders/XCTest/XCPointerEventPath.h`); CtrlProxy neither declares nor calls
them, so they are only a _potential_ private API until the runner adds and exercises
them. That header declares:

- touch paths: `initForTouchAtPoint:offset:`, `moveToPoint:atOffset:`,
  `liftUpAtOffset:`;
- pressure: `pressDownWithPressure:atOffset:` and
  `pressDownWithPressure:stage:phase:atOffset:`;
- mouse/pointer paths: `initForMouseEvents*`, `moveMouseToPoint:atOffset:duration:`,
  `pressButton:`, `releaseButton:`, `dragWithButton:`, plus `scrollWithDeltaVector:`;
- `deviceID` and `pathType` properties.

It declares nothing for Apple Pencil tilt, azimuth, roll or hover, and no stylus
tool type.

Two consequences, both **unverified** until run:

- **Pressure.** The private API accepts a pressure value, but whether the simulator
  or a device honors it for a plain touch is not established. **Reported:** a
  pressure value sent through Appium's touch actions to WebDriverAgent returns
  success on an iPad simulator and device and has no visible effect
  ([Appium forum thread](https://discuss.appium.io/t/uitouch-with-force-pressure/30470)).
  **Reported:** force touch in the Simulator is enabled through the Simulator's
  _I/O → Touch Pressure_ menu with trackpad force, not through XCUITest
  ([Apple developer forums](https://developer.apple.com/forums/thread/705708)).
- **Hover.** A mouse-style path moved without a pressed button, which needs the runner
  to declare and call the mouse selectors first, is the natural way to produce pointer
  hover on an iPad simulator; whether the simulator's iPadOS
  delivers hover to the app for it is unknown. Whether the public
  `XCUIElement.hover()` is available on iOS and iPadOS was **not confirmed**.

### Physical devices

The runner on a physical device uses the same XCTest event synthesis. There is no
public XCTest API for Pencil input, so a real Pencil's pressure, tilt and hover look
**impossible without the accessory** and, with the private paths, unverified.
`recordDeviceGestures` is Android-only (`deviceGestureRecordingManager.ts` rejects other
platforms), so there is no iOS recorder representation to extend.

## Capability matrix

| Capability                          | Android emulator                                    | Android device                   | iOS simulator                                                                       | iOS device                  |
| ----------------------------------- | --------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------- | --------------------------- |
| Stylus tool type, constant pressure | Supported via `adb shell input stylus` (**Source**) | Same (**Source**)                | Unverified (no stylus type in the path API)                                         | Unverified                  |
| Pressure curve                      | Unverified (`uinput`/console)                       | Root-only, unverified (`uinput`) | Unverified (private `pressDownWithPressure`; **Reported** no effect through Appium) | Unverified                  |
| Tilt, eraser, barrel button         | Unverified                                          | Root-only, unverified            | Impossible via known paths (**Source**)                                             | Impossible without a Pencil |
| Hover                               | Unverified (evdev only)                             | Root-only, unverified            | Unverified (mouse path)                                                             | Unverified                  |
| Records the above                   | No (**Source**)                                     | No (**Source**)                  | No                                                                                  | No                          |

"Supported" means a documented path exists in source. Nothing in the table other
than the `adb shell input stylus` cells has been demonstrated.

## Recommended API shape

1. **Pointer options on the coordinate tools, not on element tools.** Add an
   optional `pointer` object (`toolType`: `finger` | `stylus`; later `eraser`,
   `mouse`; `pressure`: a constant, 0–1) to `tapAt`, `swipeAt` and `dragPath`, the
   tools that already take raw coordinates. Element tools (`tapOn`, `swipeOn`) stay
   finger-only: a stylus has no accessibility-element meaning, and widening them
   multiplies the surface for no recorded use case. A recorded stationary stylus
   contact therefore exports through `tapAt`, never `tapOn`, so its tool type is not
   lost. A pressure _curve_ is carried by an optional per-point `pressure` on
   `dragPath` points, which already carry per-segment timing; `tapAt` and `swipeAt`
   carry the constant only. The first slice accepts the constant only, because no
   curve is proven injectable yet, and on the `adb shell input` backend that constant
   can only be `1.0` (the shell hard-codes it): that backend's capability is
   `pressure: 1.0`, and any other value is rejected under point 2, not rounded.
2. **Fail loudly instead of downgrading.** If the active device or path cannot honor
   a requested `pointer`, return an actionable error naming the missing capability.
   Never fall back to a finger touch: a silent downgrade is exactly the failure
   reported with Appium pressure above, and it makes a stylus-only UI test pass for
   the wrong reason.
3. **Hover is its own tool.** A `hoverAt` tool (move the pointer without contact,
   optionally dwell) has different semantics from a gesture: no contact, no
   scroll or fling, and the result is a UI change, not a navigation. It also has the
   weakest platform support, so it should not be bundled into the first slice.
4. **Report capability once.** Expose per-device pointer capability (tool types,
   pressure curve, hover) in the device or session description so a client can
   choose without trial and error, and so the error in point 2 is derived from the
   same data.
5. **Stage by what is proven.** First slice: `pointer.toolType: "stylus"` at the
   backend's fixed pressure (`1.0`) on `tapAt` and a straight two-point `swipeAt`, on
   Android through the `adb shell input` source prefix (the only path demonstrated in
   source, no root). `dragPath` is deferred: the shell offers a two-point `swipe` that
   interpolates a single segment, and `motionevent` calls that each get a fresh
   timestamp and down-time, and nothing in the source shows a 2–100-point,
   per-segment-timed path staying one continuous contact instead of lifting between
   invocations. Pressure curves, tilt, eraser and hover wait for the experiments
   below.

## Recording

Extending `recordDeviceGestures` needs the gesture event to carry a tool type and a
pressure series, and the exported `tapAt`, `swipeAt` or `dragPath` step to carry
`pointer`:

- `GetEventReader`/`TouchFrameReconstructor` must read `ABS_MT_TOOL_TYPE`,
  `BTN_TOOL_PEN`, `ABS_TILT_X`/`ABS_TILT_Y` and `ABS_DISTANCE`/`ABS_MT_DISTANCE`, and keep per-contact pressure over
  time, not just the last value.
- Event-node discovery must find and read the pen's node as well as the multitouch
  one, and handle non-multitouch contact coordinates (`ABS_X`/`ABS_Y`).
- Recorded pressure is a raw integer in the device's own range, but the contract is
  0–1. `TouchNodeDiscovery` must therefore parse the pressure axis minimum and maximum
  from `getevent -p`, and export normalizes against it. A missing or degenerate range
  (no axis, or `max <= min`) exports no `pressure` and warns, rather than writing a
  contract-invalid sample.
- `GestureClassifier` must keep the tool type through classification, and
  hover-only sequences (pen in range, no `BTN_TOUCH`) must not be dropped as noise.
- A drawn stroke needs path sampling and a drag classification (a new
  `GestureEventType`) exported as `dragPath`, with the sampled pressure written to the
  per-point `pressure`; attaching `pointer` to a `swipeAt` keeps only the endpoints. A
  stationary stylus contact exports as `tapAt` with `pointer`.
- Export preserves `pointer` and does not guess the replay target: the device is only
  chosen when `executePlan` runs, so the capability check and its error from point 2
  of the API shape happen at replay, when the active device is resolved. Export-time
  warnings are limited to source-side uncertainty (an unknown tool type, a missing
  pressure range, a path that was sampled coarsely), as the existing geometry
  warnings are. A stylus step never silently becomes a finger step at either point.

## Verification plan

The note's open items are answered by running them, not by more reading. Each is a
follow-up issue (see below) so it can be done where the hardware exists:

1. **Android emulator and device:** run `adb shell input stylus swipe` and
   `motionevent` against a small app that logs `MotionEvent` tool type, pressure and
   source; confirm the lowest supported API level; check `InputDevice` capability on
   an AVD; try `uinput` and emulator-console evdev for a pressure curve, tilt and
   `BTN_TOOL_PEN` hover, recording the root and image requirements.
2. **iOS simulator:** declare the pressure and mouse selectors in the runner (behind the
   existing selector probes), then call `pressDownWithPressure` and a mouse-style path
   against a probe view that logs `UITouch.force`, `maximumPossibleForce`,
   `UITouch.type` and hover callbacks; confirm `XCUIElement.hover()` availability.
3. **Physical iOS device:** repeat the probe if a device is available; otherwise
   record Pencil as out of scope.

## Follow-up issues

The feasible parts, filed from this note:

- #13081: `pointer.toolType` (stylus, pressure fixed at `1.0`) on `tapAt` and a
  straight `swipeAt` through `adb shell input`, with capability-gated errors;
  `dragPath` waits for #13082. Per-device capability
  reporting (recommendation 4) starts here, as the data those errors are derived from.
- #13082: Android emulator and device experiments (pressure curve, tilt, hover,
  `uinput`, minimum API level).
- #13083: iOS simulator and device experiments (pressure, hover, `XCUIElement.hover()`).
- #13084: recorder capture of tool type, pressure series and hover, and export of
  `pointer`.
