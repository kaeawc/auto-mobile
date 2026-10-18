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
`ABS_MT_TILT_*`/`ABS_TILT_*` and `ABS_DISTANCE` (hover distance). The pressure it
keeps is not used by the gesture classifier. A recorded stylus stroke is therefore
exported as an ordinary finger swipe or drag, and hover is invisible.

## iOS

### What the runner can carry today: touches and mouse-style paths

**Source:** CtrlProxy already drives private `XCPointerEventPath` /
`XCSynthesizedEventRecord` for pinch and multi-finger swipe
(`ObjCExceptionCatcher.m`), guarded by selector probes so a missing symbol is
reported as an availability gap, not a crash. The header from the WebDriverAgent
fork of those private classes (`PrivateHeaders/XCTest/XCPointerEventPath.h`)
declares:

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
- **Hover.** A mouse-style path moved without a pressed button is the natural way to
  produce pointer hover on an iPad simulator; whether the simulator's iPadOS
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

1. **Pointer options on the point-sequence tools, not on element tools.** Add an
   optional `pointer` object (`toolType`: `finger` | `stylus`; later `eraser`,
   `mouse`; `pressure`: 0–1) to `swipeAt` and `dragPath`, the tools that already
   take raw coordinates. Element tools (`tapOn`, `swipeOn`) stay finger-only: a
   stylus has no accessibility-element meaning, and widening them multiplies the
   surface for no recorded use case.
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
5. **Stage by what is proven.** First slice: `pointer.toolType: "stylus"` with
   constant pressure on Android through the `adb shell input` source prefix (the
   only path demonstrated in source, no root). Pressure curves, tilt, eraser and
   hover wait for the experiments below.

## Recording

Extending `recordDeviceGestures` needs the gesture event to carry a tool type and a
pressure series, and the exported `swipeAt`/`dragPath` step to carry `pointer`:

- `GetEventReader`/`TouchFrameReconstructor` must read `ABS_MT_TOOL_TYPE`,
  `BTN_TOOL_PEN` and the tilt and distance axes, and keep per-contact pressure over
  time, not just the last value.
- `GestureClassifier` must keep the tool type through classification, and
  hover-only sequences (pen in range, no `BTN_TOUCH`) must not be dropped as noise.
- Export must degrade visibly: a plan step recorded from stylus input and replayed
  on a platform that cannot honor it should warn at export (as the existing geometry
  warnings do), not silently become a finger step.

## Verification plan

The note's open items are answered by running them, not by more reading. Each is a
follow-up issue (see below) so it can be done where the hardware exists:

1. **Android emulator and device:** run `adb shell input stylus swipe` and
   `motionevent` against a small app that logs `MotionEvent` tool type, pressure and
   source; confirm the lowest supported API level; check `InputDevice` capability on
   an AVD; try `uinput` and emulator-console evdev for a pressure curve, tilt and
   `BTN_TOOL_PEN` hover, recording the root and image requirements.
2. **iOS simulator:** call `pressDownWithPressure` and a mouse-style path from the
   runner against a probe view that logs `UITouch.force`, `maximumPossibleForce`,
   `UITouch.type` and hover callbacks; confirm `XCUIElement.hover()` availability.
3. **Physical iOS device:** repeat the probe if a device is available; otherwise
   record Pencil as out of scope.

## Follow-up issues

The feasible parts, filed from this note:

- #13081: `pointer.toolType` (stylus, constant pressure) on `swipeAt`/`dragPath`
  through `adb shell input`, with capability-gated errors. Per-device capability
  reporting (recommendation 4) starts here, as the data those errors are derived from.
- #13082: Android emulator and device experiments (pressure curve, tilt, hover,
  `uinput`, minimum API level).
- #13083: iOS simulator and device experiments (pressure, hover, `XCUIElement.hover()`).
- #13084: recorder capture of tool type, pressure series and hover, and export of
  `pointer`.
