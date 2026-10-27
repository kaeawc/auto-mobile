# Stylus, pressure and hover injection (spike)

Issue #12539. Research spike: what can each platform inject beyond a plain finger
touch (tool type, pressure, tilt, stylus buttons, hover, eraser), and how should
AutoMobile expose and record it? Nothing here was run on a device. Companion note:
[Pressure, hover and stylus input](../plat/pressure-hover-stylus-input.md).

Confidence tags: **code** (verified in this repo), **doc** (public platform
documentation or AOSP behaviour, not re-exercised), **device?** (unverified; an
[experiment](#experiments-that-settle-the-unknowns) is named).

## What the code does today

| Area                | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Tag  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| Android dispatch    | CtrlProxy builds `GestureDescription.StrokeDescription(path, start, duration[, willContinue])` and calls `dispatchGesture` (`CtrlProxy.kt`: `performSwipe`, `performDrag`, `performTapCoordinates`, `performTwoFingerSwipe`, the streaming dispatcher). Only a `Path` and timing go in; no pressure, tool type or button input exists in `android/control-proxy/src/main`.                                                                                                                                                                                                                                                                                                                                                     | code |
| Android tool type   | `dispatchGesture` events arrive as `TOOL_TYPE_UNKNOWN` and some apps (DocumentsUI) ignore them (#6335; comment in `src/features/action/androidCoordinateTapPolicy.ts`). Not verified here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | doc  |
| Android adb path    | Fallback is `adb shell input touchscreen [-d display] tap/swipe/...` (`src/features/action/touchscreenInput.ts`); source is hard-wired to `touchscreen`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | code |
| Option plumbing     | `GestureOptions.pressure` (`src/models/GestureOptions.ts`) has no readers in `src/`, `android/` or `ios/`. (The recorder's `TouchSlot.pressure` is unrelated.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | code |
| Stylus handwriting  | `src/utils/disableStylusHandwriting.ts` only runs `settings put secure stylus_handwriting_enabled 0` so injected touches are not treated as handwriting.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | code |
| Recorder            | `InputNodeDiscovery` parses `getevent -p`/`-lp` into a touch node and pen nodes (single-touch `ABS_X/Y` plus `BTN_TOOL_PEN`/`RUBBER`); `GetEventReader` runs one `getevent -lt` per node; `TouchFrameReconstructor` tracks `BTN_TOOL_PEN/RUBBER`, `BTN_TOUCH`, `BTN_STYLUS*`, `ABS_MT_TOOL_TYPE`, `ABS_X/Y/PRESSURE`, `ABS_TILT_X/Y`, `ABS_DISTANCE`; `GestureEvent` carries optional `toolType`, `pressure` (min/max/mean, normalized when the axis range is known) and `buttons` (#13101). Tilt and distance stay on `TouchSlot`. A pen gesture exports as `tapAt`/`swipeAt` with `pointer: { toolType: "stylus" }`; hover and stroke events are not recorded, and a hover episode only adds a stop-result warning (#13102). | code |
| iOS dispatch        | The runner uses public `XCUICoordinate.tap/press(forDuration:thenDragTo:)` and `XCUIDevice.shared.press`. Pinch and multi-finger swipe use private `XCPointerEventPath` / `XCSynthesizedEventRecord` resolved via `NSClassFromString` and selector probes (`ObjCExceptionCatcher.m`), with a public fallback.                                                                                                                                                                                                                                                                                                                                                                                                                  | code |
| iOS private surface | `ObjCExceptionCatcher.h` declares seven selectors: `initForTouchAtPoint:offset:`, `moveToPoint:atOffset:`, `liftUpAtOffset:`, `initWithName:interfaceOrientation:`, `initWithName:displayID:interfaceOrientation:`, `addPointerEventPath:`, `synthesizeWithError:`. No pressure, hover or pencil selector. Precedent for non-touch IOHID injection exists (keyboard events in `GesturePerformer+HardwareButtons.swift`; vendor-defined hinge-angle event in `DefaultHingeAngleSetter.swift`); no digitizer events are created.                                                                                                                                                                                                 | code |

## Android

### Accessibility `dispatchGesture`

`StrokeDescription` exposes path, start time, duration and `willContinue` (newer
APIs add continuation helpers); no tool-type, pressure, tilt or button parameter,
and a `Path` has no z-axis. `setDisplayId` is the only per-gesture routing option.
A stylus route cannot go through CtrlProxy accessibility dispatch. [doc + code]
Re-check the current `GestureDescription` reference for Android 14+ additions
before closing. [doc?]

### Candidate routes

| Route                                                                                                          | Tool type / pressure                                                                                                                             | Privilege                                                                                                                                                | Notes                                                                                                                                                                       | Tag          |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `adb shell input stylus tap/swipe/draganddrop/...`                                                             | Sets `SOURCE_STYLUS`; tool type derived from source is plausible; pressure is a fixed default.                                                   | shell                                                                                                                                                    | `input` accepts a source prefix (`touchscreen`, `stylus`, `mouse`, ...). Resulting `getToolType` must be observed.                                                          | doc, device? |
| `adb shell input motionevent DOWN/MOVE/UP x y`                                                                 | Same; no pressure/tool/button arguments.                                                                                                         | shell                                                                                                                                                    | Hand-built streams, still no pressure.                                                                                                                                      | doc, device? |
| `UiAutomation.injectInputEvent(MotionEvent, sync)`                                                             | Full control: `PointerProperties.toolType`, `pressure`, `AXIS_TILT`, `AXIS_ORIENTATION`, `buttonState`, `ACTION_HOVER_*`, `ACTION_BUTTON_PRESS`. | Instrumentation process (`am instrument`) whose `UiAutomation` has a shell-backed connection. Not available to an accessibility service or ordinary app. | Strongest non-root route on physical devices. Needs an instrumentation APK or shell-run dex (`app_process`); no `injectInputEvent`/`UiAutomation` use exists in `android/`. | doc, code    |
| `InputManager.injectInputEvent` (hidden)                                                                       | Same fidelity.                                                                                                                                   | `INJECT_EVENTS` signature permission; reachable via `app_process` as shell uid                                                                           | Hidden API, greylist restrictions on recent releases.                                                                                                                       | doc, device? |
| `uinput` virtual device with `INPUT_PROP_DIRECT`, `BTN_TOOL_PEN`, `ABS_PRESSURE`, `ABS_TILT_*`, `ABS_DISTANCE` | Kernel-level, indistinguishable from real pen hardware; hover via `BTN_TOOL_PEN` + `ABS_DISTANCE` with no `BTN_TOUCH`.                           | Root / `adb root` (userdebug and emulator; `/dev/uinput` not shell-writable on production)                                                               | Closest to the recorder's `getevent` view (symmetric record/replay). Whether an idc/keylayout is needed for pen-digitizer treatment is unverified.                          | doc, device? |
| `sendevent` / writing `/dev/input/eventN`                                                                      | Same as uinput into an existing node.                                                                                                            | Root                                                                                                                                                     | Slow per-line events; only useful if the real digitizer already advertises pen axes.                                                                                        | doc          |
| Emulator gRPC `EmulatorController.sendPen`, console `event send` (EV_ABS)                                      | gRPC documented to carry pen events (pressure, eraser, buttons); console can write raw EV_ABS. Neither exercised here.                           | emulator only                                                                                                                                            | Depends on emulator build and AVD hardware profile.                                                                                                                         | doc, device? |

### Hover without root

`ACTION_HOVER_ENTER/MOVE/EXIT` come from the input dispatcher for a mouse or hovering
stylus. Non-root candidates: `UiAutomation.injectInputEvent` with a hand-built hover
`MotionEvent` (`SOURCE_STYLUS` or mouse), or `input mouse motionevent MOVE x y`.
`dispatchGesture` cannot produce hover. Which yields stylus-flavoured hover
(`TOOL_TYPE_STYLUS`, `AXIS_DISTANCE`) versus mouse hover is unverified. [device?]

### Emulator stylus capability

Whether an AVD reports a stylus-capable `InputDevice` (`SOURCE_STYLUS`, motion ranges
incl. `AXIS_PRESSURE`/`AXIS_TILT`) is unknown. Injected events are delivered
regardless of advertised ranges, but apps gating on `InputDevice` capabilities
(Compose `PointerType.Stylus`, handwriting) may still see them. `adb shell dumpsys
input` settles it. [device?]

## iOS

| Question                              | Finding                                                                                                                                                                                                                                                                                   | Tag                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Public XCTest force/pressure          | `press(forDuration:)` / `press(forDuration:thenDragTo:)` are time-based long presses. `XCUIElement` has no public force or Pencil API; a "deep press" is not injectable through public API.                                                                                               | doc                |
| Private pointer-path API              | `XCPointerEventPath` already drives multi-touch. Known versions (Appium WDA) also expose `pressDownAtOffset:` and sometimes pressure-bearing variants; none are declared or probed here. Whether any selector accepts pressure or a pencil pointer type on the current Xcode is unknown.  | code, device?      |
| Pencil / stylus on simulator          | No Pencil hardware; a pencil `UITouch` (`type == .pencil`, `force`, `altitudeAngle`, `azimuth`) needs a pencil event path not known to be synthesizable via XCTest.                                                                                                                       | doc, device?       |
| Hover (iPadOS pointer / Pencil hover) | `UIHoverGestureRecognizer` is driven by a trackpad/mouse on iPad; the simulator maps the host pointer to touches. No known public XCTest API for iOS hover (`XCUIElement.hover()` is macOS to our knowledge). Pencil hover needs M2-class iPad hardware.                                  | doc, device?       |
| Physical devices                      | Same XCTest APIs through the runner. Real Pencil input cannot be faked by XCTest; the only candidate is private IOHID digitizer injection (`IOHIDEventSystemClient*`), with precedent in the keyboard and vendor-defined events above. Needs on-device validation and entitlement checks. | doc, code, device? |
| Recording                             | No `getevent` equivalent; recording stylus on iOS is out of scope.                                                                                                                                                                                                                        | doc                |

## Capability matrix

`S` supported, `R` root-only, `E` emulator-only, `I` instrumentation-only, `X`
impossible, `?` unknown.

| Capability               | Android emulator                                                                               | Android physical                                  | iOS simulator                     | iOS physical               |
| ------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------- | -------------------------- |
| Tool type (stylus)       | I via `injectInputEvent`; `input stylus` maybe S; gRPC `sendPen` / console candidate (device?) | I; `input stylus` maybe S (device?); R via uinput | ? (private APIs, device?)         | ? (private IOHID, device?) |
| Eraser tool type         | I (doc); gRPC `sendPen` eraser candidate (device?)                                             | I (doc); R via `BTN_TOOL_RUBBER` (doc)            | ? (device?)                       | ? (device?)                |
| Pressure                 | I (doc); gRPC `sendPen` candidate (device?)                                                    | I (doc); R uinput `ABS_PRESSURE` (doc)            | ? (device?)                       | ? (device?)                |
| Tilt / orientation       | I (doc)                                                                                        | I (doc); R uinput `ABS_TILT_*` (doc)              | ? (device?)                       | ? (device?)                |
| Stylus buttons           | I `buttonState` (doc); gRPC `sendPen` candidate (device?)                                      | I; R uinput `BTN_STYLUS*` (doc)                   | ? (device?)                       | ? (device?)                |
| Hover                    | I hover events (doc); mouse hover via `input mouse` (device?)                                  | same                                              | X for public API (doc); ? private | ? (device?)                |
| Plain finger touch today | S (code)                                                                                       | S (code)                                          | S (code)                          | S (code)                   |

CtrlProxy `dispatchGesture` is `X` for the first four rows (code + doc).

## Recommended API shape

Add optional fields to the existing coordinate tools rather than new tools:

- `tapAt`: `toolType` (`"finger" | "stylus" | "eraser"`, default `"finger"`),
  `pressure` (0..1), optional `tilt`/`orientation`, `buttons`.
- `swipeAt` (`durationMs`): same fields; scalar `pressure` is constant for the stroke.
- `dragPath` (`src/server/dragPathTool.ts`: `points[{x,y,durationMs}]`, `holdMs`,
  `releaseHoldMs`, `coordinateSpace`, `display`, `snapshotId`, `layer`): same
  tool-level fields plus optional per-point `pressure`/`tilt`.
- `hoverAt`: a separate small tool (hover has no contact). Reuses the `dragPath`
  point schema (per-point `durationMs`, optional `distance`) and the same
  `coordinateSpace`, `display`, `snapshotId`, `layer` fields.

Rationale:

- The mental model is "same gesture, different pointer"; tool count and schema size
  already burden `tool-definitions.json`. Defaults keep current calls unchanged.
- Capability varies by device. Follow the CtrlProxy `*_v1` convention
  (`gesture_display_id_v1`, `multi_finger_gesture_v1` in `ctrlProxyProtocol.ts`): the
  runner advertises `stylus_input_v1` / `hover_input_v1` and a request needing one
  is refused before dispatch on older APKs with an actionable error. A host-side
  `pointerInput` summary is derived from those flags and the chosen route, never a
  second source of truth. Never silently degrade to a finger touch.
- Android routes sit behind one interface (`PointerInjector`: `ctrlproxy-a11y`,
  `adb-input-source`, `instrumentation`, `uinput`, emulator gRPC) chosen by required
  features; finger-only requests keep the fast CtrlProxy path; the interface needs
  a fake.
- Tilt and buttons stay Android-only until iOS can honour them.

## Recording representation

- `recordToolCalls` records AutoMobile tool calls to YAML. Injected gestures are not
  seen by the `getevent` recorder by design
  (`DEVICE_GESTURE_RECORDING_USER_INPUT_ONLY_NOTICE` in
  `src/daemon/deviceGestureRecordingManager.ts`), so the new params and `hoverAt`
  ride along in recorded plans with no recorder work.
- `recordDeviceGestures` observes physical input via `getevent`. A recorded pen tap, long
  press or swipe exports as `tapAt`/`swipeAt` with `pointer: { toolType: "stylus" }`, so replay
  injects a stylus and never a finger; an eraser gesture is left out with a warning.

Remaining `recordDeviceGestures` work (additive; finger recordings keep their shape):

1. Surface `tilt` and `distance` on `GestureEvent` where replay needs them.
2. `pressure` as a sampled array for strokes.
3. New event types `hover` (positions, `distance`) and `stroke` (pen path with
   per-point pressure), since a pressure-varying pen drag is not faithfully a `swipe`.
4. Replay maps these to the tool fields above and fails loudly if the route cannot
   honour them.

`BTN_TOOL_PEN` without `BTN_TOUCH` is the raw hover signal, so the recorder can
observe hover on real pen hardware even where injection is impossible. [doc]

## Experiments that settle the unknowns

The Playground **Pointer Probe** screen (#13096) is the probe view for experiments
2, 3, 4 and 6. Open it from Home > Demos > Pointer Probe or
`adb shell am start -a android.intent.action.VIEW -d automobile://playground/demos/input/pointer_probe`
(app onboarded and logged in). A custom View logs every `MotionEvent` from
`onTouchEvent`, `onHoverEvent` and `onGenericMotionEvent`: callback, action,
`deviceId`, `source`, `buttonState`, per-pointer `toolType`, `getPressure()`,
`AXIS_TILT`, `AXIS_ORIENTATION`, x/y. The newest 20 lines are Text nodes
`pointer_probe_event_0` (newest) to `pointer_probe_event_19`; `pointer_probe_count`
is the running total and `pointer_probe_clear` empties the log, so `observe` can
read results. A hover reaching both the View and the Compose hover fallback is
logged once (copies matched by `deviceId`, action and event time, since their
coordinate spaces differ). Device results are still to be collected.

1. `adb shell dumpsys input` on an API 34+ AVD and a physical pen device: devices,
   sources, motion ranges.
2. `input stylus swipe` / `input stylus motionevent` against the probe: `toolType`,
   `source`, `getPressure()`, `AXIS_TILT`.
3. `input mouse motionevent MOVE` for hover events and their `toolType`/`source`.
4. Minimal `am instrument` APK calling `UiAutomation.injectInputEvent` with a stylus
   `MotionEvent` (pressure, tilt, button, hover): confirms the route, measures startup.
5. Rooted device or userdebug AVD: create a `uinput` pen device, verify
   `SOURCE_STYLUS` with ranges, confirm the recorder round-trips it.
6. Emulator gRPC `sendPen` and console `event send` EV_ABS against the probe.
7. iOS: dump `XCPointerEventPath` / `XCSynthesizedEventRecord` method lists on the
   pinned Xcode, test whether any selector changes `UITouch.force` or `UITouch.type`
   in a probe app on an iPad simulator, and try an IOHID digitizer event through the
   existing `dlsym` pattern.

## Proposed follow-up issues

1. Android pointer-injection experiments (1-3, 5, 6) via Pointer Probe (#13096).
2. Android instrumentation injection route (`UiAutomation.injectInputEvent`):
   shell-identity injector (instrumentation APK or `app_process` dex) with tool type,
   pressure, tilt, buttons, hover; measure startup latency and failure modes.
3. `PointerInjector` interface, `stylus_input_v1`/`hover_input_v1` capabilities,
   derived `pointerInput` summary, pre-dispatch errors, routing off the accessibility path.
4. `toolType` and `pressure` on tapAt/swipeAt/dragPath: wire the unused
   `GestureOptions.pressure`, per-point `pressure`, schemas and `tool-definitions.json`.
5. `hoverAt` for Android; document mouse vs stylus hover semantics.
6. Recorded stylus gestures: `stroke` / `hover` wire shape and replay with strict
   unsupported-feature failures.
7. iOS private-API probe for pressure/pencil on the pinned Xcode.
8. iOS physical-device Pencil and hover feasibility (IOHID digitizer injection;
   likely outcome "document as unsupported").
9. Optional `uinput` pen device for rooted devices and userdebug emulators, only if
   instrumentation proves insufficient for fidelity or record/replay symmetry.

## Implemented: route selection (#13098)

`src/features/action/pointer/` holds the `PointerInjector` interface and three routes:
`ctrlproxy-a11y` (finger only), `adb-input-source` (constant-pressure stylus on API 31+) and
`instrumentation` (stylus pressure, and stylus or mouse hover, gated on the runner flags
`stylus_input_v1` / `hover_input_v1`). `selectPointerRoute` takes the first supporting route in that
order, so finger touches keep the accessibility path; a request no route can honour is refused
before dispatch with the missing capability named, and contradictory requests (a finger hover,
hover with pressure, a mouse click) are refused as invalid. `derivePointerInput` reports, per
feature, the route that would carry it from the same support, never a second source of truth.
The `uinput` and emulator gRPC route ids are reserved; their injectors arrive with their spikes.
CtrlProxy now advertises the flags and injects through its instrumentation (below).

## Instrumentation route (#13097)

Status: built and unit-tested without a device; **real injection is unverified**. Go/no-go as the
primary stylus route waits for the probe plan below.

**Shape.** CtrlProxy declares `PointerInstrumentation` (`<instrumentation>` in its manifest). The host
starts it with
`adb shell am instrument -w -r --no-restart -e request <base64 json> dev.jasonpearson.automobile.ctrlproxy/.pointer.PointerInstrumentation`.

**Why `--no-restart` (an Opus review finding).** The instrumentation targets CtrlProxy's own package, and
`am instrument` force-stops its target when it starts and again when it finishes unless given
`--no-restart`. Without it every injection would kill the accessibility service and its WebSocket
server. The flag arrived with the Android 13 `am`, so CtrlProxy advertises `stylus_input_v1` and
`hover_input_v1` only on API 33 and newer (`PointerInjectionSupport`); an older device is refused with
the flags absent, and a `am` that rejects the flag reports it. Both the API level and that the
connection survives are assumptions the probe must confirm. A separate package for the
instrumentation, or a `app_process` injector, are the fallbacks if they do not hold.
It validates the request, gets a `UiAutomation` with `FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES`
(without it the system silences CtrlProxy's own accessibility service for the duration), plays the
planned `MotionEvent`s through `injectInputEvent`, and reports `success`, `error`, `injected` and
`elapsedMs` as `INSTRUMENTATION_RESULT` lines. The host side is `createInstrumentationDispatch`.

**Pieces.** `PointerInjectionPlanner` (framework-free: a hover is ENTER, interpolated MOVEs every 16 ms
and EXIT; a stroke is DOWN, MOVEs, UP with pressure, distance, tilt and orientation interpolated
between waypoints) and its validation; `PointerRequestCodec`; `PointerInjectionExecutor` (schedules
events and, if one is refused or the run is cancelled, closes the pointer with CANCEL or HOVER_EXIT);
`UiAutomationPointerSink` (the only class that touches `MotionEvent`). CtrlProxy advertises
`stylus_input_v1` and `hover_input_v1` (API 33+); `hoverAt` uses the route.

**Failure modes, designed for and to be confirmed on a device.**

| Failure                                                                                                            | Behaviour                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Instrumentation not in the installed APK                                                                           | `am instrument` reports it cannot find it; the host says to update CtrlProxy, nothing was sent                          |
| Process killed mid-run                                                                                             | No result is reported; the host says the outcome is unknown and to verify with `observe`                                |
| An event is refused (secure window, locked device)                                                                 | The executor closes the pointer and reports the count injected                                                          |
| `UiAutomation` unavailable (another UiAutomation client, such as a running UiAutomator test, holds the connection) | Reported as an error before any event                                                                                   |
| Non-default display                                                                                                | Refused: routing needs the hidden `setDisplayId`; not implemented                                                       |
| Cold start                                                                                                         | Each call starts a process (host timeout allows 15 s on top of the planned time); latency is measured by the plan below |

## Probe plan for #13082 and the go/no-go (not run: manual tests are paused)

Use the Playground **Pointer Probe** screen (#13096) on an API 34+ AVD and a physical pen device. Each
step writes a row into the result table (route, capability, root or emulator requirement, API level).

1. `adb shell dumpsys input`: record input devices, sources and motion ranges for stylus capability.
2. `adb shell input stylus swipe`/`motionevent`: probe `toolType`, `source`, `getPressure()`,
   `AXIS_TILT`; find the minimum API level where the tool type is stylus.
3. `adb shell input mouse motionevent MOVE x y`: hover events, their tool type and source.
4. **This route.** For a stylus stroke with pressure rising 0.1 to 1.0, a hover path with `distance`
   falling 1.0 to 0.0, a barrel button (`buttons: 32`) and a mouse hover: confirm the probe logs
   `TOOL_TYPE_STYLUS` (or MOUSE), the injected pressures, `AXIS_DISTANCE`, `AXIS_TILT` and
   ENTER/MOVE/EXIT at the requested points; confirm CtrlProxy's accessibility service keeps working
   during the run (the suppress flag).
5. **Connection survival (first):** with CtrlProxy connected and its accessibility service enabled, run one hover and confirm the WebSocket stays up, the service stays enabled and the process is not restarted (`pidof` before and after); find the lowest API level where `--no-restart` is accepted.
6. Latency: 20 cold runs and 20 back-to-back runs of a one-point hover and a 1-second stroke; record
   process start to first event, and per-event drift against the plan.
7. Failure modes: kill the instrumentation mid-hover, lock the device, open a secure (FLAG_SECURE)
   window, hold a UiAutomator test session, request display 1 on a multi-display AVD.
8. Rooted or userdebug AVD only: `uinput` pen device and emulator gRPC `sendPen` against the probe.

**Go criteria for making this the primary stylus route:** tool type and pressure arrive as injected
on a stock API 31+ device without root, hover works, p50 cold start under 1.5 s, and every failure
mode above reports instead of hanging. A fail on any keeps `adb input stylus` as the stylus tap and
swipe route and leaves this one hover-only.

## Rich stylus on tapAt, swipeAt and dragPath (#13099)

The nested `pointer` option keeps its shape and gains `tilt`, `orientation` (radians) and `buttons`
(`primary`, `secondary`); `pressure` may be any 0..1. A plain stylus (`pressure` omitted or 1) still uses
`adb input stylus`, so existing calls are unchanged. Anything the shell cannot inject, and every stylus
`dragPath` (per-point `pressure` and `tilt`, holds as repeats of the first and last point), goes through
`dispatchRichStylus` and the instrumentation route. `strokeRequest` sets only the features the request
needs (`variablePressure`, `extendedAxes`, `path`), so a refusal names the real reason, and the refusal
comes before the display fence and any dispatch hook. A failure after dispatch is
`StylusOutcomeIndeterminateError` (do not retry) unless the route says nothing was sent
(`PointerNotSentError`). `doubleTap` and panel selection are still refused with a stylus.
The acceptance item that a stylus `tapAt` with pressure reaches the probe screen with that pressure
needs a device (#13082).
