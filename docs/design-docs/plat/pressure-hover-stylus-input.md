# Pressure, hover and stylus input

AutoMobile injects finger touches. It cannot yet drive stylus-only drawing modes,
pressure-sensitive brushes, palm rejection, hover previews, Apple Pencil
interactions or force-press menus. This note records what each platform's
injection path can carry and the direction that follows (#12539). Companion spike:
[Stylus, pressure and hover injection](../mcp/stylus-pressure-hover-injection.md).

**Status:** shipped so far (#13081): a stylus pointer on `tapAt` and a straight
`swipeAt` for Android 12+, at pressure 1.0. Otherwise a research note. Nothing was
verified on physical hardware; the iOS simulator probe is recorded below. Remaining
claims needing a device are marked **unverified** and carried into the
[verification plan](#verification-plan).

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

`uinput` and emulator-console are expected to work because both inject at the evdev
layer, where pressure, tilt and `BTN_TOOL_PEN` hover are ordinary axes (a
hypothesis). In-process `Instrumentation` injectors reach only the instrumented
app's own windows, which does not fit the black-box model. `UiAutomation.injectInputEvent`
is documented to work across app boundaries with arbitrary `InputEvent`s, so a
constructed `MotionEvent` could carry stylus tool type, pressure, tilt and buttons
without root; whether the shell can host that, and its cost beside CtrlProxy, is
unverified (#13082) and should be settled before `uinput` is the only richer route.

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
  becomes a tap or swipe. A pen that comes into range and leaves again without ever touching
  (a single-touch pen's tool key down then up, or a multitouch pen reporting a hover
  distance until its tracking id ends) is reported once as a `hover` event, which the
  recorder turns into a stop-result warning. Hover around a contact is not reported, and a
  digitizer that reports no hover distance cannot be told from contact.
- **Pressure axes.** A touch node reports `ABS_MT_PRESSURE`; a single-touch pen node
  reports the non-multitouch `ABS_PRESSURE` instead. Discovery reads each node's axis range
  from `getevent -p`, and the raw values are scaled to 0-1 against it; without a usable
  range the raw values are kept and `pressure.normalized` is false.
- **Gesture fields.** `GestureEvent` carries optional `toolType` (`stylus`/`eraser`),
  `pressure` (min, max and mean, normalized when the axis range is known) and `buttons`.
  A pen gesture exports as a coordinate step carrying `pointer: { toolType: "stylus" }`: a
  tap or long press as `tapAt`, a swipe as `swipeAt`, never `tapOn` or `swipeOn`, which cannot
  say "stylus". Recorded pressure is not exported, because replay injects the fixed 1.0 and
  refuses anything else. A pen gesture with no replayable form (an eraser, which replay cannot
  inject, or one with no known position or path) is left out with a warning on the stop
  result, which a salvaged stop keeps. A stylus double tap is exported with a warning because
  replay refuses it. A stylus tap and a finger tap never merge into one double tap. Finger
  gestures export unchanged. Hover is not exported (it only warns), nor are stroke paths or
  pressure series.

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

The simulator probe in #13083 establishes two limits:

- **Pressure.** The private pressure selectors accept and range-check values, and
  raw `XCPointerEvent` pressure is delivered, but `UITouch.force` stays `0.000`.
  Pressure and Pencil injection are a no-go on the simulator: pressure has no
  observable effect, and selector inventory exposes no pen, Pencil, tilt, azimuth,
  altitude or tool-type selector on `XCPointerEvent`, `XCPointerEventPath` or
  `XCSynthesizedEventRecord`. `setDeviceID` values 0–3 still produce touch type 0.
  Public force press returns "Force press events are not supported for this device."
  A pressure fallback cannot be validated there. **Reported:** Appium pressure
  actions likewise succeed without visible effect
  ([Appium forum thread](https://discuss.appium.io/t/uitouch-with-force-pressure/30470)).
- **Hover.** Mouse pointer paths produce `UIHoverGestureRecognizer` begin/end
  callbacks on the simulator. Pencil hover is not observed. Public
  `XCUIElement.hover()` and `XCUICoordinate.hover()` exist, but this observation is
  from mouse pointer paths and does not establish the public calls' behavior.

### Physical devices

The runner on a physical device uses the same XCTest event synthesis. There is no
public XCTest API for Pencil input, so a real Pencil's pressure, tilt and hover look
**impossible without the accessory** and, with the private paths, unverified.
`recordDeviceGestures` is Android-only (`deviceGestureRecordingManager.ts` rejects other
platforms), so there is no iOS recorder representation to extend.

## Capability matrix

| Capability                          | Android emulator                                                                                    | Android device                                     | iOS simulator                                                         | iOS device                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------- | --------------------------- |
| Stylus tool type, constant pressure | Supported via `adb shell input stylus` on API 31+; earlier releases drop the tool type (**Source**) | Same (**Source**)                                  | No-go: no Pencil tool type; accepted pressure leaves force 0 (#13083) | Unverified                  |
| Pressure curve                      | Unverified (`uinput`/console)                                                                       | Unverified (`UiAutomation`; `uinput` is root-only) | No-go: accepted pressure leaves force 0 (#13083)                      | Unverified                  |
| Tilt, eraser, barrel button         | Unverified                                                                                          | Unverified (`UiAutomation`; `uinput` is root-only) | No-go via known paths: no pen or tool-type selectors (#13083)         | Impossible without a Pencil |
| Hover                               | Unverified (evdev only)                                                                             | Unverified (`UiAutomation`; `uinput` is root-only) | Observed on mouse pointer paths; Pencil hover not observed (#13083)   | Unverified                  |
| Records the above                   | Partly: tool type, pressure, buttons (#13101); not hover or replay (**Source**)                     | Same (**Source**)                                  | No (**Source**, Android-only recorder)                                | No (**Source**)             |

"Supported" means a documented path exists in source. Mouse pointer hover is
observed on the iOS simulator; pressure and Pencil injection are a no-go there.

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
- **Recording follows the tools.** A stylus step is never silently exported or replayed as a
  finger step; hover, stroke path and pressure series are the recorder gaps under
  [What the recorder sees](#what-the-recorder-sees).

## Verification plan

Open items are answered by running them, each as a follow-up issue (below):

1. **Android emulator and device:** run `adb shell input stylus swipe` and
   `motionevent` against a small app that logs `MotionEvent` tool type, pressure and
   source; confirm the lowest supported API level; confirm how a panel key or role maps
   onto `-d DISPLAY_ID` and whether two shell invocations hold a double-tap interval;
   check `InputDevice` capability on an AVD; try `UiAutomation.injectInputEvent`,
   `uinput` and emulator-console evdev for a pressure curve, tilt, `BTN_TOOL_PEN`
   hover, `BTN_TOOL_RUBBER` (eraser) and `BTN_STYLUS`/`BTN_STYLUS2` (barrel buttons),
   recording the root and image requirements for each.
2. **iOS simulator:** the probe in #13083 (Xcode 26.6, iPad Pro 13-inch (M5),
   iOS 26.5, base `f8d061423c9`) establishes pressure and Pencil injection as a
   no-go: accepted pressure leaves `UITouch.force` at 0, and no Pencil tool type
   is exposed. Mouse pointer hover produces `UIHoverGestureRecognizer` begin/end;
   Pencil hover is not observed.
3. **Physical iOS device:** repeat the probe if a device is available; otherwise
   record Pencil as out of scope.

## Follow-up issues

- #13081: stylus tool type at fixed pressure on `tapAt` and a straight `swipeAt`
  through `adb shell input`, with capability-gated errors.
- #13082: Android emulator and device experiments (pressure curve, tilt, hover, eraser
  and barrel buttons, `UiAutomation.injectInputEvent`, `uinput`, minimum API level).
- #13083: iOS simulator and device experiments (pressure, hover through the public
  `hover()` calls first, private selectors as the fallback).
- #13084: recorder capture of tool type, pressure, hover and the pen's event node, and
  export of the pointer.
