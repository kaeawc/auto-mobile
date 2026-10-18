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

It runs as the shell user, so it needs neither root nor an installed helper. **Not
checked:** which releases have each command and source. Only `main` was read;
`motionevent` and the source prefix should be confirmed against the lowest API level
AutoMobile supports before depending on them.

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

`recordDeviceGestures` reads kernel events with `getevent`. The reconstruction
(`TouchFrameReconstructor.ts`) keeps position and `ABS_MT_PRESSURE` per slot, and
nothing else: it ignores `ABS_MT_TOOL_TYPE`, `BTN_TOOL_PEN`, `BTN_STYLUS`,
`ABS_TILT_X`/`ABS_TILT_Y`, and `ABS_DISTANCE`/`ABS_MT_DISTANCE` (hover distance).
The pressure it keeps is not used by the gesture classifier. A recorded stylus stroke is therefore
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

| Capability                          | Android emulator                                    | Android device                                     | iOS simulator                                                                       | iOS device                  |
| ----------------------------------- | --------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------- |
| Stylus tool type, constant pressure | Supported via `adb shell input stylus` (**Source**) | Same (**Source**)                                  | Unverified (no stylus selector in the header)                                       | Unverified                  |
| Pressure curve                      | Unverified (`uinput`/console)                       | Unverified (`UiAutomation`; `uinput` is root-only) | Unverified (private `pressDownWithPressure`; **Reported** no effect through Appium) | Unverified                  |
| Tilt, eraser, barrel button         | Unverified                                          | Unverified (`UiAutomation`; `uinput` is root-only) | Impossible via known paths (**Source**)                                             | Impossible without a Pencil |
| Hover                               | Unverified (evdev only)                             | Unverified (`UiAutomation`; `uinput` is root-only) | Unverified (mouse path)                                                             | Unverified                  |
| Records the above                   | No (**Source**)                                     | No (**Source**)                                    | No (**Source**, Android-only recorder)                                              | No (**Source**)             |

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
4. **Report capability once, per operation.** Expose pointer capability in the device
   or session description, keyed by tool and action (or by backend path) rather than as
   one flat device tuple: for each of `tapAt` tap, long press and double tap, `swipeAt`
   and `dragPath`, the supported tool types, the fixed or allowed constant pressure
   values, whether a pressure curve is accepted, and whether hover applies. A flat
   tuple could not say that stylus works for a tap and a straight swipe but not for a
   double tap or a drawn path, and the same record can then drive replay validation, so
   a client can choose without trial and error, and so the error in point 2 is derived
   from the same data. The reported pressure values matter because a backend that accepts only
   `1.0` is otherwise indistinguishable from one that accepts any constant.
5. **Stage by what is proven.** First slice: `pointer.toolType: "stylus"` at the
   backend's fixed pressure (`1.0`) on `tapAt` and a straight two-point `swipeAt`, on
   Android through the `adb shell input` source prefix (the only path demonstrated in
   source, no root), which changes the source of a path AutoMobile already uses for
   swipes and long presses. `tapAt` covers `tap` and `longPress` (a zero-distance
   swipe with a duration); `doubleTap` is excluded until the experiment shows two
   shell invocations hold the double-tap interval despite host latency. The `display`
   option takes a panel key or role, not a raw display id, so mapping it onto the
   shell's `-d DISPLAY_ID` is part of the slice and is checked in the experiment. `dragPath` is deferred: the shell offers a two-point `swipe` that
   interpolates a single segment, and `motionevent` calls that each get a fresh
   timestamp and down-time, and nothing in the source shows a 2–100-point,
   per-segment-timed path staying one continuous contact instead of lifting between
   invocations. Pressure curves, tilt, eraser and hover wait for the experiments
   below.

## Recording

The full recorder requirements belong to #13084 and get specified when that work is
picked up. This note fixes only the constraints the API shape puts on it, on top of
the gaps listed under [What the recorder sees](#what-the-recorder-sees):

- Export preserves `pointer` on `tapAt`, `swipeAt` and `dragPath` steps and never turns
  a stylus step into a finger step. The device is only chosen when `executePlan` runs,
  so the capability check and its error happen at replay.
- A stationary contact exports as `tapAt` and a drawn stroke as `dragPath`, which needs
  a drag classification that does not exist today.
- Pressure is exported on the contract's 0–1 scale, normalized against the node's own
  axis range; an unknown or degenerate range omits `pressure` and warns.
- Anything the recorder cannot represent yet, hover today, is reported in an export
  warning instead of being dropped silently.

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

The feasible parts, filed from this note:

- #13081: `pointer.toolType` (stylus, pressure fixed at `1.0`) on `tapAt` and a
  straight `swipeAt` through `adb shell input`, with capability-gated errors;
  `dragPath` waits for #13082. Per-device capability reporting (recommendation 4),
  including the accepted pressure values, starts here, as the data those errors are
  derived from. AutoMobile supports API 24, and only AOSP `main` was read, so the
  stylus capability is fail-closed: it is advertised only after a receiving probe
  observes `TOOL_TYPE_STYLUS` on an injected event, or after the minimum-API part of
  #13082 shows that on every supported release. A successful `input stylus` command is
  not enough: older releases build the event with a legacy `MotionEvent` overload that
  changes the source but can leave the tool type unknown, and applications are told to
  read `getToolType()` regardless of the reported source.
- #13082: Android emulator and device experiments (pressure curve, tilt, hover, eraser
  and barrel buttons, `UiAutomation.injectInputEvent`, `uinput`, minimum API level).
- #13083: iOS simulator and device experiments (pressure, hover through the public
  `hover()` calls first, private selectors as the fallback).
- #13084: recorder capture of tool type, pressure series and hover, and export of
  `pointer`.
