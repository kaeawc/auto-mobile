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
| **Measured**   | Run against the Playground Pointer Probe on an emulator; the issue named holds the log. |
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
which carries no tool type, while `android-12.0.0_r1` assigns it (#13081). **Measured**
(#13082): on API 30 `input stylus` arrives as source `STYLUS` with tool type `UNKNOWN`; on API 31,
32, 33 and 37 it arrives as `TOOL_TYPE_STYLUS`. `motionevent` accepts only `DOWN`, `UP`, `MOVE`
and, from API 31, `CANCEL`; `HOVER_MOVE` is rejected as `Unknown action`. **Not checked:**
releases before API 24.

So `adb shell input` can produce a _binary_ stylus (stylus tool type, full pressure
for the whole stroke). It cannot produce a pressure curve, tilt, an eraser or hover.

### Routes to richer input

Measured on an API 37 `google_apis` userdebug emulator against the Pointer Probe (#13082) unless a
cell says **Source**:

| Route                                               | Tool type           | Pressure curve            | Tilt           | Buttons                              | Eraser                                    | Hover                                    | Needs                                                   |
| --------------------------------------------------- | ------------------- | ------------------------- | -------------- | ------------------------------------ | ----------------------------------------- | ---------------------------------------- | ------------------------------------------------------- |
| Accessibility `dispatchGesture` (today)             | Finger (**Source**) | No (**Source**)           | No             | No                                   | No                                        | No (**Source**)                          | Accessibility service                                   |
| `adb shell input stylus tap/swipe/motionevent`      | Stylus (API 31+)    | No, fixed 1.0             | No             | No                                   | No                                        | No                                       | `adb` only                                              |
| `adb shell input mouse tap`                         | Mouse               | No, fixed 1.0             | No             | No                                   | No                                        | One `HOVER_ENTER` before `DOWN` only     | `adb` only                                              |
| `UiAutomation.injectInputEvent` (instrumentation)   | Stylus or mouse     | Yes, any 0-1              | Yes            | `STYLUS_PRIMARY`                     | No (the route rejects it)                 | Yes, enter/move/exit, stylus or mouse    | `am instrument --no-restart`: API 31+, no root          |
| Virtual stylus through `uinput` (kernel evdev)      | Stylus and eraser   | Yes, scaled from the axis | Yes            | `BTN_STYLUS` as `STYLUS_PRIMARY`     | Yes (`BTN_TOOL_RUBBER`)                   | Yes (`BTN_TOOL_PEN` without `BTN_TOUCH`) | `adb root` (userdebug or emulator); no idc or keylayout |
| Emulator gRPC `streamInputEvent` with a `pen_event` | Stylus              | Yes, scaled from 0-1024   | No             | `button_pressed` as `STYLUS_PRIMARY` | No (`rubber_pointer` arrives as a finger) | No (pressure 0 delivers nothing)         | Emulator started with `-grpc <port>`; no root, no auth  |
| Emulator console `event send` raw evdev             | **Unverified**      | **Unverified**            | **Unverified** | **Unverified**                       | **Unverified**                            | **Unverified**                           | Emulator only                                           |
| `Instrumentation.sendPointerSync` and similar       | n/a                 | n/a                       | n/a            | n/a                                  | n/a                                       | n/a                                      | Own process only                                        |

So the instrumentation route is the only non-root route with tilt and hover, and `uinput` is the only
route with an eraser. The emulator has no `sendPen` RPC: pen input goes through
`EmulatorController/streamInputEvent` with `InputEvent.pen_event`
(`emulator/lib/emulator_controller.proto`). In-process `Instrumentation` injectors reach only the
instrumented app's own windows, which does not fit the black-box model.

Every emulator `virtio_input_multi_touch_N` device reports `Sources: KEYBOARD | TOUCHSCREEN |
STYLUS` with pressure 0-1024 and no `BTN_TOOL_PEN`; tilt and distance have no range. So an AVD
advertises a stylus-capable `InputDevice` but no tilt or distance axes (**Measured**, API 37).

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
  A pen gesture exports as a coordinate step carrying `pointer: { toolType: "stylus" }` (or
  `"eraser"`): a tap or long press as `tapAt`, a swipe as `swipeAt`, never `tapOn` or `swipeOn`,
  which cannot say "stylus". Recorded pressure is not exported, because replay injects the fixed 1.0 and
  refuses anything else. A pen gesture with no known position or path is left out with a warning
  on the stop result, which a salvaged stop keeps. An eraser gesture is exported with a warning
  because only a root `adb shell` with the `uinput` tool can replay it. A stylus double tap is exported with a warning because
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

| Capability                          | Android emulator                                                                                                              | Android device                                     | iOS simulator                                                         | iOS device                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------- | --------------------------- |
| Stylus tool type, constant pressure | Supported via `adb shell input stylus` on API 31+; API 30 reports tool type `UNKNOWN` (**Measured**)                          | Same (**Source**)                                  | No-go: no Pencil tool type; accepted pressure leaves force 0 (#13083) | Unverified                  |
| Pressure curve                      | Instrumentation, `uinput` (root) and gRPC pen (**Measured**)                                                                  | Unverified (`UiAutomation`; `uinput` is root-only) | No-go: accepted pressure leaves force 0 (#13083)                      | Unverified                  |
| Tilt, eraser, barrel button         | Tilt and button via instrumentation (**Measured**) or `uinput` encoding (**Source**); eraser via `uinput` only (**Measured**) | Unverified (`UiAutomation`; `uinput` is root-only) | No-go via known paths: no pen or tool-type selectors (#13083)         | Impossible without a Pencil |
| Hover                               | Instrumentation (stylus or mouse) and `uinput` (**Measured**)                                                                 | Unverified (`UiAutomation`; `uinput` is root-only) | Observed on mouse pointer paths; Pencil hover not observed (#13083)   | Unverified                  |
| Records the above                   | Partly: tool type, pressure, buttons (#13101); not hover or replay (**Source**)                                               | Same (**Source**)                                  | No (**Source**, Android-only recorder)                                | No (**Source**)             |

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

1. **Android:** a physical pen device's `dumpsys input` axes, emulator-console
   `event send`, how a panel key or role maps onto `-d DISPLAY_ID`, and whether two shell
   invocations hold a double-tap interval.
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
