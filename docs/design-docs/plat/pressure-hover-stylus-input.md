# Pressure, hover and stylus input

AutoMobile injects finger touches. It cannot yet drive stylus-only drawing modes,
pressure-sensitive brushes, palm rejection, hover previews, Apple Pencil
interactions or force-press menus. This note records what each platform's
injection path can carry, states the direction that follows, and lists the follow-up
work (#12539).

**Status:** the first slice shipped in #13081: a stylus pointer on `tapAt` and a straight
`swipeAt` for Android 12 and later, at pressure 1.0. This note is otherwise a research note,
not a design for a shipped tool, and the rest of it is unchanged. Nothing here was run on an
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

### What AutoMobile can carry today: fingers only

Android touch input reaches the device two ways, and both inject a finger:

- CtrlProxy's `AccessibilityService.dispatchGesture` (`CtrlProxy.kt`:
  `performTapCoordinates`, `performSwipe`, `performDrag`, `performPinch`, and the
  streaming `StrokeDescription` coordinator).
- `adb shell input swipe`, with no source prefix so the shell defaults to
  `touchscreen`. `ExecuteGesture.ts` uses it as its default swipe mode (the
  accessibility swipe is the opt-in `a11y` mode), and `androidLongPress.ts` expresses
  a long press as a zero-distance swipe with a duration.

**Source:** `GestureDescription` carries no input-device data. A stroke is a `Path`
with a start time and duration. The internal `TouchPoint` has only a stroke id,
continuation id, start/end-of-path flags and `x`/`y`. There is no field for tool
type, pressure, tilt, button state or hover, so no change inside CtrlProxy's
accessibility dispatch can produce a stylus event. Beyond geometry, timing and stroke
continuation, the only per-gesture knob is the target display
(`Builder.setDisplayId`, API 30).

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

It runs as the shell user, so it needs neither root nor an installed helper. The tool type
is only set from the source from Android 12 (API 31): `Input.java` from `android-7.0.0_r36`
through `android-11.0.0_r48` builds the event with the legacy `MotionEvent.obtain` overload,
which carries no tool type, while `android-12.0.0_r1` assigns it (#13081). **Not checked:**
`motionevent` across releases, and releases before API 24.

So `adb shell input` can produce a _binary_ stylus (stylus tool type, full pressure
for the whole stroke). It cannot produce a pressure curve, tilt, an eraser or hover.

### Routes to richer input

| Route                                             | Pressure curve             | Tilt / buttons / eraser | Hover           | Needs                                                                  |
| ------------------------------------------------- | -------------------------- | ----------------------- | --------------- | ---------------------------------------------------------------------- |
| Accessibility `dispatchGesture` (today)           | No (**Source**)            | No (**Source**)         | No (**Source**) | Accessibility service                                                  |
| `adb shell input stylus ...`                      | No, fixed 1.0 (**Source**) | No (**Source**)         | No (**Source**) | `adb` only                                                             |
| Virtual stylus through `uinput` (kernel evdev)    | **Unverified**             | **Unverified**          | **Unverified**  | `/dev/uinput` write access; likely root or an emulator/userdebug image |
| Emulator console `event send` raw evdev           | **Unverified**             | **Unverified**          | **Unverified**  | Emulator only                                                          |
| `UiAutomation.injectInputEvent` (instrumentation) | **Unverified**             | **Unverified**          | **Unverified**  | An instrumentation process; documented to work across app boundaries   |
| `Instrumentation.sendPointerSync` and similar     | n/a                        | n/a                     | n/a             | Own process only                                                       |

The `uinput` and emulator-console rows are expected to work because both inject at
the evdev layer, where pressure, tilt and `BTN_TOOL_PEN` hover are ordinary axes and
keys; that is a hypothesis, not a finding. The in-process `Instrumentation`
injectors reach only the instrumented app's own windows, which does not fit
AutoMobile's black-box model. `UiAutomation.injectInputEvent` is different: Android
documents it as working across application boundaries with arbitrary `InputEvent`s, so
a constructed `MotionEvent` could carry a stylus tool type, pressure, tilt and button
state without root. Whether the shell can host that, and what it costs to run an
instrumentation process beside CtrlProxy, is unverified and is part of #13082 before
`uinput` is treated as the only richer route.

Whether the emulator exposes a stylus-capable input device to apps (an
`InputDevice` with `SOURCE_STYLUS`) depends on the AVD hardware profile and is
**unverified**.

### What the recorder sees

`recordDeviceGestures` reads kernel events with `getevent`. Since #13101 the recorder
also reads pen data (**Source**):

- **Pen nodes.** `InputNodeDiscovery.ts` finds the touch node and any separate
  single-touch pen node (`ABS_X`/`ABS_Y` plus `BTN_TOOL_PEN` or `BTN_TOOL_RUBBER`), and
  `GetEventReader` runs one `getevent -lt` process per node.
- **Pen state.** `TouchFrameReconstructor.ts` tracks `ABS_MT_TOOL_TYPE`, `BTN_TOOL_PEN`/
  `BTN_TOOL_RUBBER`, `BTN_TOUCH`, `BTN_STYLUS`/`BTN_STYLUS2`, `ABS_TILT_X`/`ABS_TILT_Y` and
  `ABS_DISTANCE`/`ABS_MT_DISTANCE`. A pen in range without contact is hover and never
  becomes a tap or swipe.
- **Pressure axes.** A touch node reports `ABS_MT_PRESSURE`; a single-touch pen node
  reports the non-multitouch `ABS_PRESSURE` instead. Discovery reads each node's axis range
  from `getevent -p`, and the raw values are scaled to 0-1 against it; without a usable
  range the raw values are kept and `pressure.normalized` is false.
- **Gesture fields.** `GestureEvent` carries optional `toolType` (`stylus`/`eraser`),
  `pressure` (min, max and mean, normalized when the axis range is known) and `buttons`.
  Exported plan steps are unchanged, so a recorded stylus stroke still replays as a finger
  gesture; hover events, stroke paths and replay are #13102.

One structural limit remains, and extending the axes alone does not remove it
(**Source**):

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
- **Hover.** The public route to try first is XCTest's own `XCUIElement.hover()` and
  the coordinate-based `XCUICoordinate.hover()`, which would give a coordinate `hoverAt`
  a documented primitive. Their availability on iOS and iPadOS (reported as iPadOS 15
  and later) was **not confirmed** here. Only if the public call fails the probe is
  the fallback a mouse-style private path moved without a pressed button, which needs
  the runner to declare and call the mouse selectors first; whether the simulator's
  iPadOS delivers hover to the app for either is unknown.

### Physical devices

The runner on a physical device uses the same XCTest event synthesis. There is no
public XCTest API for Pencil input, so a real Pencil's pressure, tilt and hover look
**impossible without the accessory** and, with the private paths, unverified.
`recordDeviceGestures` is Android-only (`deviceGestureRecordingManager.ts` rejects other
platforms), so there is no iOS recorder representation to extend.

## Capability matrix

| Capability                          | Android emulator                                                                                    | Android device                                     | iOS simulator                                                                       | iOS device                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------- |
| Stylus tool type, constant pressure | Supported via `adb shell input stylus` on API 31+; earlier releases drop the tool type (**Source**) | Same (**Source**)                                  | Unverified (no stylus selector in the header)                                       | Unverified                  |
| Pressure curve                      | Unverified (`uinput`/console)                                                                       | Unverified (`UiAutomation`; `uinput` is root-only) | Unverified (private `pressDownWithPressure`; **Reported** no effect through Appium) | Unverified                  |
| Tilt, eraser, barrel button         | Unverified                                                                                          | Unverified (`UiAutomation`; `uinput` is root-only) | Impossible via known paths (**Source**)                                             | Impossible without a Pencil |
| Hover                               | Unverified (evdev only)                                                                             | Unverified (`UiAutomation`; `uinput` is root-only) | Unverified (mouse path)                                                             | Unverified                  |
| Records the above                   | Partly: tool type, pressure, buttons (#13101); not hover or replay (**Source**)                     | Same (**Source**)                                  | No (**Source**, Android-only recorder)                                              | No (**Source**)             |

"Supported" means a documented path exists in source. Nothing in the table other
than the `adb shell input stylus` cells has been demonstrated.

## Direction

Only the direction is fixed here; the design lives in the follow-up issues, where it is
specified and reviewed when the work is picked up.

- **Pointer options on the coordinate tools.** Stylus input is an optional option on
  `tapAt`, `swipeAt` and `dragPath`, not on the element tools (`tapOn`, `swipeOn`): a
  stylus has no accessibility-element meaning.
- **Fail loudly instead of downgrading.** A device or path that cannot honor a
  requested pointer returns an actionable error. It never falls back to a finger
  touch: a silent downgrade is the failure reported with Appium pressure above, and it
  makes a stylus-only UI test pass for the wrong reason.
- **Hover is its own tool.** A `hoverAt` tool has different semantics from a gesture
  (no contact, no scroll or fling) and the weakest platform support, so it is not part
  of the first slice.
- **Stage by what is proven.** The only path demonstrated in source is the stylus
  source of `adb shell input`, at a fixed pressure of `1.0`. The first slice is that,
  for `tapAt` and a straight `swipeAt`; pressure curves, tilt, eraser, hover and
  `dragPath` wait for the experiments below.
- **Recording follows the tools.** The recorder gaps under
  [What the recorder sees](#what-the-recorder-sees) are #13084's work. A stylus step is
  never silently exported or replayed as a finger step.

## Verification plan

The note's open items are answered by running them, not by more reading. Each is a
follow-up issue (see below) so it can be done where the hardware exists:

1. **Android emulator and device:** run `adb shell input stylus swipe` and
   `motionevent` against a small app that logs `MotionEvent` tool type, pressure and
   source; confirm the lowest supported API level; confirm how a panel key or role maps
   onto `-d DISPLAY_ID` and whether two shell invocations hold a double-tap interval;
   check `InputDevice` capability on an AVD; try `UiAutomation.injectInputEvent`,
   `uinput` and emulator-console evdev for a pressure curve, tilt, `BTN_TOOL_PEN`
   hover, `BTN_TOOL_RUBBER` (eraser) and `BTN_STYLUS`/`BTN_STYLUS2` (barrel buttons),
   recording the root and image requirements for each.
2. **iOS simulator:** probe the public `XCUIElement.hover()` and `XCUICoordinate.hover()`
   first, against a probe view that logs `UITouch.force`, `maximumPossibleForce`,
   `UITouch.type` and hover callbacks, and confirm their availability. Only if they fail,
   declare the pressure and mouse selectors in the runner (behind the existing selector
   probes) and try `pressDownWithPressure` and a mouse-style path.
3. **Physical iOS device:** repeat the probe if a device is available; otherwise
   record Pencil as out of scope.

## Follow-up issues

The feasible parts, filed from this note, each carrying its own design and acceptance
criteria:

- #13081: stylus tool type at fixed pressure on `tapAt` and a straight `swipeAt`
  through `adb shell input`, with capability-gated errors.
- #13082: Android emulator and device experiments (pressure curve, tilt, hover, eraser
  and barrel buttons, `UiAutomation.injectInputEvent`, `uinput`, minimum API level).
- #13083: iOS simulator and device experiments (pressure, hover through the public
  `hover()` calls first, private selectors as the fallback).
- #13084: recorder capture of tool type, pressure, hover and the pen's event node, and
  export of the pointer.
