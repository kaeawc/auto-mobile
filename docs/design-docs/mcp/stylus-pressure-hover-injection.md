# Stylus, pressure and hover injection (spike)

Issue #12539. Research spike: what can each platform inject beyond a plain
finger touch (tool type, pressure, tilt, stylus buttons, hover, eraser), and how
should AutoMobile expose and record it? No code changed.

Confidence tags used below:

- **code**: verified by reading this repository at the commit of this note.
- **doc**: stated in public platform documentation or AOSP behaviour known to the
  author; not re-fetched or exercised here.
- **device?**: unverified. A device experiment is named in [Experiments](#experiments-that-settle-the-unknowns).

Nothing in this note was run on a device.

## What the code does today

| Area                | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Tag  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Android dispatch    | CtrlProxy builds `GestureDescription.StrokeDescription(path, start, duration[, willContinue])` and calls `dispatchGesture` (`CtrlProxy.kt`: `performSwipe`, `performDrag`, `performTapCoordinates`, `performTwoFingerSwipe`, the streaming gesture dispatcher, `dispatchGestureWithResult`). Only a `Path` and timing go in; there is no pressure, tool type or button input anywhere in `android/control-proxy/src/main`.                                                                                                                                                                                                                                                                                                                                           | code |
| Android tool type   | `src/features/action/androidCoordinateTapPolicy.ts:4-6` is only a comment citing #6335: `dispatchGesture` events arrive as `TOOL_TYPE_UNKNOWN` and some apps (DocumentsUI) ignore them. Not verified here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | doc  |
| Android adb path    | Fallback is `adb shell input touchscreen [-d display] tap/swipe/...` (`src/features/action/touchscreenInput.ts`). Source is hard-wired to `touchscreen`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | code |
| Option plumbing     | `GestureOptions.pressure` (`src/models/GestureOptions.ts:18`) has no readers in `src/`, `android/` or `ios/`. (The recorder's `TouchSlot.pressure` is unrelated.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | code |
| Stylus handwriting  | `src/utils/disableStylusHandwriting.ts` only runs `settings put secure stylus_handwriting_enabled 0` so injected touches are not treated as handwriting.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | code |
| Recorder            | Since #13101: `InputNodeDiscovery` parses real `getevent -p`/`-lp` output into a touch node and pen nodes (single-touch `ABS_X/Y` plus `BTN_TOOL_PEN`/`RUBBER`); `GetEventReader` runs one `getevent -lt` process per node. `TouchFrameReconstructor` tracks `BTN_TOOL_PEN/RUBBER`, `BTN_TOUCH`, `BTN_STYLUS*`, `ABS_MT_TOOL_TYPE`, `ABS_X/Y/PRESSURE` (pen nodes), `ABS_TILT_X/Y` and `ABS_DISTANCE`; `GestureEvent` carries optional `toolType`, `pressure` (min/max/mean, normalized when the axis range is known) and `buttons`. Tilt and distance stay on `TouchSlot`; hover/stroke events and replay are not implemented (#13102).                                                                                                                             | code |
| iOS dispatch        | The runner uses public `XCUICoordinate.tap/press(forDuration:thenDragTo:)` and `XCUIDevice.shared.press`. Pinch and multi-finger swipe use private `XCPointerEventPath` / `XCSynthesizedEventRecord` resolved with `NSClassFromString` and selector probes (`ObjCExceptionCatcher.m`), with a public fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                       | code |
| iOS private surface | `ObjCExceptionCatcher.h:14-25` declares seven selectors: `initForTouchAtPoint:offset:`, `moveToPoint:atOffset:`, `liftUpAtOffset:`, `initWithName:interfaceOrientation:`, `initWithName:displayID:interfaceOrientation:`, `addPointerEventPath:`, `synthesizeWithError:`. No pressure, hover or pencil selector is declared or used. Precedent for non-touch IOHID injection exists: keyboard events (`IOHIDEventCreateKeyboardEvent`, `GesturePerformer+HardwareButtons.swift:148`) and the vendor-defined hinge-angle event (`IOHIDEventCreateVendorDefinedEvent` / `IOHIDVirtualServiceClientDispatchEvent`, `DefaultHingeAngleSetter.swift:108-128,202-213`); `XCTestQueryTimeout.swift:113` dlsyms `_XCTSetXPCRequestTimeout`. No digitizer events are created. | code |

## Android

### Accessibility `dispatchGesture`

`GestureDescription.StrokeDescription` exposes path, start time, duration and
`willContinue`; newer API levels add continuation helpers. It has no tool-type,
pressure, tilt or button parameters. Injected events reach apps as
`TOOL_TYPE_UNKNOWN` (the platform builds the events; code evidence in the policy
file above). A Path carries no z axis, so pressure is not representable. Display
targeting (`setDisplayId`) is the only per-gesture routing option. Conclusion: a
stylus route cannot go through CtrlProxy accessibility dispatch. [doc + code]

Android 14+ added no public stylus knob to `GestureDescription` that the author
could confirm. Worth a re-check against the current `GestureDescription` API
reference before closing this out. [device?/doc?]

### Candidate routes

| Route                                                                                                                          | Tool type / pressure                                                                                                                                                              | Privilege                                                                                                                                | Notes                                                                                                                                                                                                                      | Tag          |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `adb shell input stylus tap/swipe/draganddrop/...`                                                                             | Sets `SOURCE_STYLUS` on the event. Tool type derived from the source (finger vs stylus) is plausible; pressure is a fixed default (no argument).                                  | shell (no root)                                                                                                                          | `input` accepts a source prefix (`touchscreen`, `stylus`, `mouse`, ...); the repo already uses `input touchscreen`. Whether the resulting `MotionEvent.getToolType` is `TOOL_TYPE_STYLUS` must be observed.                | doc, device? |
| `adb shell input motionevent DOWN/MOVE/UP x y`                                                                                 | Same as above; the `motionevent` command is documented as taking action + coordinates, no pressure/tool/button arguments.                                                         | shell                                                                                                                                    | Allows hand-built streams; still no pressure.                                                                                                                                                                              | doc, device? |
| `UiAutomation.injectInputEvent(MotionEvent, sync)`                                                                             | Full control: caller builds `MotionEvent` with `PointerProperties.toolType`, `pressure`, `AXIS_TILT`, `AXIS_ORIENTATION`, `buttonState`, `ACTION_HOVER_*`, `ACTION_BUTTON_PRESS`. | Needs an instrumentation process (`am instrument`) running as shell identity. Not available to an accessibility service or ordinary app. | The strongest non-root route on physical devices. Requires shipping an instrumentation APK or a shell-run dex (`app_process`); no such path exists today (grep for `injectInputEvent`/`UiAutomation` in `android/`: none). | doc, code    |
| `InputManager.injectInputEvent` (hidden)                                                                                       | Same fidelity as above.                                                                                                                                                           | `INJECT_EVENTS` signature permission; reachable via `app_process` as shell uid                                                           | Hidden API; subject to greylist/restrictions on recent releases.                                                                                                                                                           | doc, device? |
| `uinput` virtual device (`/dev/uinput`) with `INPUT_PROP_DIRECT`, `BTN_TOOL_PEN`, `ABS_PRESSURE`, `ABS_TILT_*`, `ABS_DISTANCE` | Kernel-level, indistinguishable from real pen hardware; hover via `BTN_TOOL_PEN` + `ABS_DISTANCE` with no `BTN_TOUCH`.                                                            | Root or `adb root` (userdebug/emulator images; `/dev/uinput` is not shell-writable on production builds)                                 | Closest to the recorder's `getevent` view, which makes record/replay symmetric. Production devices: root-only. Whether an idc/keylayout is needed for the framework to treat the node as a pen digitizer is unverified.    | doc, device? |
| `sendevent` / writing `/dev/input/eventN`                                                                                      | Same as uinput but into an existing node.                                                                                                                                         | Root (device node is not shell-writable on production builds)                                                                            | Slow, per-line events; only useful if the real digitizer already advertises pen axes.                                                                                                                                      | doc          |
| Emulator gRPC `EmulatorController.sendPen`, console `event send` (EV_ABS)                                                      | The emulator gRPC API is documented to carry pen events (pressure, eraser, buttons); console `event send` can write raw EV_ABS codes. Neither is exercised in this repo.          | emulator only                                                                                                                            | Candidates only: depends on emulator build and AVD hardware profile. Settle with the experiments below.                                                                                                                    | doc, device? |

### Hover without root

`ACTION_HOVER_ENTER/MOVE/EXIT` are generated by the input dispatcher from a
mouse or a hovering stylus. Non-root candidates: `UiAutomation.injectInputEvent`
with a hand-built hover `MotionEvent` (source `SOURCE_STYLUS` or mouse),
or `input mouse motionevent MOVE x y` (a mouse move yields hover events in the
target view). Accessibility `dispatchGesture` cannot produce hover. Which of
these yields a stylus-flavoured hover (`TOOL_TYPE_STYLUS`, `getAxisValue(AXIS_DISTANCE)`)
versus mouse hover is unverified. [doc, device?]

### Emulator stylus capability

Whether an AVD reports a stylus-capable input device to apps (an
`InputDevice` with `SOURCE_STYLUS`, visible through
`InputDevice.getMotionRanges()` including `AXIS_PRESSURE`/`AXIS_TILT`) is
unknown here. Capability reporting is per `InputDevice`; injected events through
`injectInputEvent` are delivered regardless of the device's advertised ranges,
but apps that gate on `InputDevice` capabilities (for example Compose
`PointerType.Stylus` UI, handwriting) may still see them. `adb shell dumpsys
input` on an AVD lists devices and their sources and settles it. [device?]

## iOS

| Question                              | Finding                                                                                                                                                                                                                                                                                                                                                                                                           | Tag                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Public XCTest force/pressure          | `XCUICoordinate.press(forDuration:)` / `press(forDuration:thenDragTo:)` are time-based long presses. `XCUIElement` has no public force or Pencil API. A "deep press" is not injectable through public API.                                                                                                                                                                                                        | doc                |
| Private pointer-path API              | `XCPointerEventPath` is already used for multi-touch (`initForTouchAtPoint:offset:` is in use). Known versions of the class (Appium WDA, xcuitest-driver) also expose `pressDownAtOffset:`, and in some Xcode versions pressure-bearing variants; none are declared or probed in this repo. Whether any selector accepts pressure or a pencil pointer type on the current Xcode is unknown.                       | code, device?      |
| Pencil / stylus on simulator          | Simulator has no Pencil hardware. Pencil-flavoured `UITouch` (`type == .pencil`, `force`, `altitudeAngle`, `azimuth`) would need a pencil event path. Not known to be synthesizable via XCTest. Apps on iPad simulators can use `UIPencilInteraction` only on real hardware.                                                                                                                                      | doc, device?       |
| Hover (iPadOS pointer / Pencil hover) | Pointer hover (`UIHoverGestureRecognizer`) is driven by a trackpad/mouse on iPad. Simulator maps the host pointer to touches; synthesised hover has no known public XCTest API (`XCUIElement.hover()` is macOS, not iOS, to our knowledge). Pencil hover needs M2-class iPad hardware.                                                                                                                            | doc, device?       |
| Physical devices                      | Same XCTest APIs apply through the runner. Real Pencil input cannot be faked by XCTest; the only candidate is private IOHID digitizer injection (`IOHIDEventSystemClient*`). The repo already injects keyboard and vendor-defined IOHID events (see the private surface row) but no digitizer events, which is the precedent for experiment 7 and follow-up 9. Needs on-device validation and entitlement checks. | doc, code, device? |
| Recording                             | iOS has no `getevent` equivalent; host-side capture of Pencil input is not available. Recording stylus on iOS is out of scope.                                                                                                                                                                                                                                                                                    | doc                |

## Capability matrix

`S` supported, `R` root-only, `E` emulator-only, `I` instrumentation-only, `X`
impossible, `?` unknown. Tag in parentheses.

| Capability               | Android emulator                                                                               | Android physical                                  | iOS simulator                     | iOS physical               |
| ------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------- | -------------------------- |
| Tool type (stylus)       | I via `injectInputEvent`; `input stylus` maybe S; gRPC `sendPen` / console candidate (device?) | I; `input stylus` maybe S (device?); R via uinput | ? (private APIs, device?)         | ? (private IOHID, device?) |
| Eraser tool type         | I (doc); gRPC `sendPen` eraser candidate (device?)                                             | I (doc); R via `BTN_TOOL_RUBBER` (doc)            | ? (device?)                       | ? (device?)                |
| Pressure                 | I (doc); gRPC `sendPen` candidate (device?)                                                    | I (doc); R uinput `ABS_PRESSURE` (doc)            | ? (device?)                       | ? (device?)                |
| Tilt / orientation       | I (doc)                                                                                        | I (doc); R uinput `ABS_TILT_*` (doc)              | ? (device?)                       | ? (device?)                |
| Stylus buttons           | I `buttonState` (doc); gRPC `sendPen` candidate (device?)                                      | I; R uinput `BTN_STYLUS*` (doc)                   | ? (device?)                       | ? (device?)                |
| Hover                    | I hover events (doc); mouse hover via `input mouse` (device?)                                  | same                                              | X for public API (doc); ? private | ? (device?)                |
| Plain finger touch today | S (code)                                                                                       | S (code)                                          | S (code)                          | S (code)                   |

CtrlProxy `dispatchGesture` is `X` for every cell in the first four rows
(code + doc).

## Recommended API shape

Add optional fields to the existing coordinate tools rather than new tools,
matching their current schemas:

- `tapAt`: `toolType` (`"finger" | "stylus" | "eraser"`, default `"finger"`),
  `pressure` (0..1), optional `tilt`/`orientation`, `buttons`.
- `swipeAt` (`durationMs`): the same fields; a scalar `pressure` is constant for
  the whole stroke.
- `dragPath` (`src/server/dragPathTool.ts`: `points[{x,y,durationMs}]`, `holdMs`,
  `releaseHoldMs`, `coordinateSpace`, `display`, `snapshotId`, `layer`): the same
  tool-level fields, plus an optional per-point `pressure` (and `tilt`) so a
  varying-pressure stroke is expressible.
- `hoverAt`: a separate small tool because hover has no contact. It reuses the
  `dragPath` point schema (`points` with per-point `durationMs`, optional
  per-point `distance`) and the same `coordinateSpace`, `display`, `snapshotId`
  and `layer` fields.

Rationale:

- The agent's mental model is "same gesture, different pointer", and tool count
  and schema size already burden `tool-definitions.json`. Defaults keep every
  current call unchanged.
- Capability varies by device. Follow the CtrlProxy `*_v1` convention
  (`gesture_display_id_v1`, `multi_finger_gesture_v1` in `ctrlProxyProtocol.ts`):
  new flags such as `stylus_input_v1` and `hover_input_v1` are advertised by the
  runner and a request needing one is refused before dispatch on older APKs with
  an actionable error. A host-side `pointerInput` summary (route, stylus,
  pressure, hover) is derived from those flags and from the chosen route; it is
  never a second source of truth. Never silently degrade to a finger touch.
- Android routes sit behind one interface (`PointerInjector`: `ctrlproxy-a11y`,
  `adb-input-source`, `instrumentation`, `uinput`, emulator gRPC), chosen by
  required features. Finger-only requests keep the fast CtrlProxy path. The
  interface needs a fake for deterministic unit tests, per repo convention.
- Tilt and buttons stay Android-only until iOS can honour them; the schema marks
  them platform-limited.

## Recording representation

Two different things are called recording:

- `recordToolCalls` records AutoMobile tool calls to YAML. Injected gestures are
  not seen by the `getevent` recorder by design
  (`DEVICE_GESTURE_RECORDING_USER_INPUT_ONLY_NOTICE` in
  `src/server/deviceGestureRecordingManager.ts:22`; `docs/tools.md`
  `recordToolCalls`). The new `toolType`, `pressure`, `tilt`, `buttons` params and
  `hoverAt` calls therefore ride along in recorded plans for free, with no
  recorder work.
- `recordDeviceGestures` observes physical input via `getevent`. Stylus
  support there is only for observing a real pen.

Remaining `recordDeviceGestures` changes (additive; finger recordings keep their
shape). Pen-node discovery, per-node `getevent`, pen key/axis parsing and the
`toolType`/`pressure`/`buttons` fields on `GestureEvent` landed in #13101 (see
the table above). Still to do:

1. Surface `tilt` and `distance` on `GestureEvent` where replay needs them.
2. `pressure` as a sampled array for strokes.
3. New event types `hover` (positions, `distance`) and `stroke` (a pen path with
   per-point pressure), since a pressure-varying pen drag is not faithfully a
   `swipe`.
4. Replay maps these to the tool fields above and fails loudly if the target
   route cannot honour them.

`BTN_TOOL_PEN` without `BTN_TOUCH` is the hover signal in raw Linux input, so the
recorder can observe hover on real pen hardware even where injection is
impossible. [doc]

## Experiments that settle the unknowns

The Playground **Pointer Probe** screen (#13096) is the probe view for experiments 2, 3, 4 and 6.
Open it from Home > Demos > Pointer Probe, or with
`adb shell am start -a android.intent.action.VIEW -d automobile:playground/demos/input/pointer_probe`
(the app must be onboarded and logged in). A custom View receives every `MotionEvent` through
`onTouchEvent`, `onHoverEvent` and `onGenericMotionEvent` and logs one line per event: the callback
(`touch`/`hover`/`generic`), action (DOWN/MOVE/UP, HOVER_ENTER/MOVE/EXIT, ...), `deviceId`,
`source` names, `buttonState` names, and per pointer `toolType`, `getPressure()`, `AXIS_TILT`,
`AXIS_ORIENTATION` and x/y. The newest 20 lines are Text nodes tagged `pointer_probe_event_0`
(newest) to `pointer_probe_event_19`; `pointer_probe_count` holds the running total and
`pointer_probe_clear` empties the log, so `observe` can read results after an injection. Device
results are still to be collected.

1. `adb shell dumpsys input` on an API 34+ AVD and a physical pen device: list
   devices, sources and motion ranges (emulator stylus capability).
2. Run `input stylus swipe` / `input stylus motionevent` against a probe view
   logging `toolType`, `source`, `getPressure()`, `AXIS_TILT`.
3. Probe `input mouse motionevent MOVE` for hover events and their
   `toolType`/`source`.
4. Minimal `am instrument` APK that calls `UiAutomation.injectInputEvent` with a
   stylus `MotionEvent` (pressure, tilt, button, hover): confirms the full route
   and measures startup cost.
5. On a rooted device or userdebug AVD, create a `uinput` pen device and verify
   the framework treats it as `SOURCE_STYLUS` with ranges; confirm the recorder
   round-trips it.
6. Emulator: try gRPC `EmulatorController.sendPen` and console `event send`
   EV_ABS against the probe view; record which pressure/eraser/button values
   arrive.
7. iOS: dump `XCPointerEventPath` / `XCSynthesizedEventRecord` method lists with
   the Objective-C runtime on the pinned Xcode, test whether any selector changes
   `UITouch.force` or `UITouch.type` in a probe app on an iPad simulator, and
   try an IOHID digitizer event through the existing `dlsym` pattern.

## Proposed follow-up issues

1. **Android pointer-injection probe app and experiments.** Build a Playground
   screen logging tool type, source, pressure, tilt, buttons and hover for every
   MotionEvent; run experiments 1-3, 5 and 6 and record results in this note.
2. **Android instrumentation injection route (`UiAutomation.injectInputEvent`).**
   Prototype a shell-identity injector (instrumentation APK or `app_process`
   dex) supporting tool type, pressure, tilt, buttons and hover; measure startup
   latency and failure modes.
3. **`PointerInjector` interface, `stylus_input_v1`/`hover_input_v1` capabilities
   and routing.** Introduce the interface plus fakes, the `*_v1` flags with a
   derived host `pointerInput` summary, actionable pre-dispatch errors, and
   routing of stylus requests off the accessibility path.
4. **Add `toolType` and `pressure` to tapAt/swipeAt/dragPath.** Wire the unused
   `GestureOptions.pressure` end to end, add per-point `pressure` on dragPath
   points, extend schemas and `tool-definitions.json`.
5. **`hoverAt` tool for Android.** Hover enter/move/exit using the dragPath
   point schema; document mouse vs stylus hover semantics.
6. **Recorder: parse pen input** (#13101, done). Non-MT `ABS_X/Y/PRESSURE`,
   per-node `getevent`, `BTN_TOOL_*`, `BTN_TOUCH`, tilt and distance, with
   pressure and tool type carried into `GestureEvent`.
7. **Recorded stylus gestures: wire shape and replay.** Define `stroke` / `hover`
   event types and their serialization, and replay with strict
   unsupported-feature failures.
8. **iOS private-API probe for pressure/pencil.** Enumerate the pointer-path
   selectors on the pinned Xcode, test force/type on an iPad simulator, and
   decide whether to add a probed, fallback-guarded path.
9. **iOS physical-device Pencil and hover feasibility.** Assess IOHID digitizer
   injection (building on the existing keyboard / vendor-defined IOHID
   precedent) and entitlements; likely outcome is "document as unsupported".
10. **uinput pen device for rooted devices and userdebug emulators (optional).**
    Only if the instrumentation route proves insufficient for fidelity or
    record/replay symmetry.
