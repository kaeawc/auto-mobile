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

| Area                | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Tag  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Android dispatch    | CtrlProxy builds `GestureDescription.StrokeDescription(path, start, duration[, willContinue])` and calls `dispatchGesture` (`CtrlProxy.kt` swipe/drag/tap/pinch/streaming). Only a `Path` and timing go in; there is no pressure, tool type or button input anywhere in `android/control-proxy/src/main`.                                                                                                                                                                                                                                                                       | code |
| Android tool type   | `src/features/action/androidCoordinateTapPolicy.ts` already records that `dispatchGesture` events arrive as `TOOL_TYPE_UNKNOWN` and that some apps (DocumentsUI, #6335) ignore them.                                                                                                                                                                                                                                                                                                                                                                                            | code |
| Android adb path    | Fallback is `adb shell input touchscreen [-d display] tap/swipe/...` (`src/features/action/touchscreenInput.ts`). Source is hard-wired to `touchscreen`.                                                                                                                                                                                                                                                                                                                                                                                                                        | code |
| Option plumbing     | `GestureOptions.pressure?: number` (0.0-1.0) exists in `src/models/GestureOptions.ts` but nothing outside the recorder reads a `.pressure` field: it is declared and unused.                                                                                                                                                                                                                                                                                                                                                                                                    | code |
| Stylus handwriting  | `src/utils/disableStylusHandwriting.ts` only runs `settings put secure stylus_handwriting_enabled 0` so injected touches are not treated as handwriting.                                                                                                                                                                                                                                                                                                                                                                                                                        | code |
| Recorder            | `getevent` is parsed by `TouchFrameReconstructor`. It handles `ABS_MT_SLOT/TRACKING_ID/POSITION_X/Y`, `ABS_MT_PRESSURE` (stored on `TouchSlot.pressure`) and `KEY_*` buttons. It ignores `BTN_TOOL_PEN`, `BTN_TOOL_RUBBER`, `BTN_STYLUS*`, `BTN_TOUCH`, `ABS_MT_TOOL_TYPE`, `ABS_DISTANCE`, `ABS_TILT_X/Y`, `ABS_MT_DISTANCE`. Pressure is captured per slot but `GestureClassifier` / `GestureEvent` do not emit it. `TouchNodeDiscovery` picks the first node with `ABS_MT_POSITION_X/Y`, so a separate pen digitizer node would be skipped if a finger node is listed first. | code |
| iOS dispatch        | The runner uses public `XCUICoordinate.tap/press(forDuration:thenDragTo:)` and `XCUIDevice.shared.press`. Pinch and multi-finger swipe use private `XCPointerEventPath` / `XCSynthesizedEventRecord` resolved with `NSClassFromString` and selector probes (`ObjCExceptionCatcher.m`), with a public fallback.                                                                                                                                                                                                                                                                  | code |
| iOS private surface | The declared selectors are only `initForTouchAtPoint:offset:`, `moveToPoint:atOffset:`, `liftUpAtOffset:`, `addPointerEventPath:`, `synthesizeWithError:`. No pressure, hover or pencil selector is declared or used. `IOHIDEventCreateKeyboardEvent` is dlsym'd for hardware keys (`GesturePerformer+HardwareButtons.swift`).                                                                                                                                                                                                                                                  | code |

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
| `uinput` virtual device (`/dev/uinput`) with `INPUT_PROP_DIRECT`, `BTN_TOOL_PEN`, `ABS_PRESSURE`, `ABS_TILT_*`, `ABS_DISTANCE` | Kernel-level, indistinguishable from real pen hardware; hover via `BTN_TOOL_PEN` + `ABS_DISTANCE` with no `BTN_TOUCH`.                                                            | Root (or shell on userdebug/emulator images where `/dev/uinput` is writable)                                                             | Closest to the recorder's `getevent` view, which makes record/replay symmetric. Production devices: root-only. Needs idc/keylayout so the framework treats the node as a pen digitizer.                                    | doc, device? |
| `sendevent` / writing `/dev/input/eventN`                                                                                      | Same as uinput but into an existing node.                                                                                                                                         | Root (device node is not shell-writable on production builds)                                                                            | Slow, per-line events; only useful if the real digitizer already advertises pen axes.                                                                                                                                      | doc          |
| Emulator console / virtio input                                                                                                | Emulator forwards host events; the console `event` / `rotate`-style commands are limited to touch/key. Stylus support depends on the AVD hardware profile and emulator build.     | emulator only                                                                                                                            | Unknown whether the console can send pen events.                                                                                                                                                                           | device?      |

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

| Question                              | Finding                                                                                                                                                                                                                                                                                                                                                                         | Tag                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Public XCTest force/pressure          | `XCUICoordinate.press(forDuration:)` / `press(forDuration:thenDragTo:)` are time-based long presses. `XCUIElement` has no public force or Pencil API. A "deep press" is not injectable through public API.                                                                                                                                                                      | doc                |
| Private pointer-path API              | `XCPointerEventPath` is already used for multi-touch. Known versions of the class (Appium WDA, xcuitest-driver) also expose `initForTouchAtPoint:offset:`, `pressDownAtOffset`, and in some Xcode versions pressure-bearing variants; none are declared or probed in this repo. Whether any selector accepts pressure or a pencil pointer type on the current Xcode is unknown. | code, device?      |
| Pencil / stylus on simulator          | Simulator has no Pencil hardware. Pencil-flavoured `UITouch` (`type == .pencil`, `force`, `altitudeAngle`, `azimuth`) would need a pencil event path. Not known to be synthesizable via XCTest. Apps on iPad simulators can use `UIPencilInteraction` only on real hardware.                                                                                                    | doc, device?       |
| Hover (iPadOS pointer / Pencil hover) | Pointer hover (`UIHoverGestureRecognizer`) is driven by a trackpad/mouse on iPad. Simulator maps the host pointer to touches; synthesised hover has no known public XCTest API (`XCUIElement.hover()` exists on macOS only). Pencil hover needs M2-class iPad hardware.                                                                                                         | doc, device?       |
| Physical devices                      | Same XCTest APIs apply through the runner. Real Pencil input cannot be faked by XCTest; the only paths are private IOHID event injection (`IOHIDEventSystemClient*` with digitizer events), which the repo already touches via `dlsym` for keyboard events only. Needs on-device validation and entitlement checks.                                                             | doc, code, device? |
| Recording                             | iOS has no `getevent` equivalent; host-side capture of Pencil input is not available. Recording stylus on iOS is out of scope.                                                                                                                                                                                                                                                  | doc                |

## Capability matrix

`S` supported, `R` root-only, `E` emulator-only, `I` instrumentation-only, `X`
impossible, `?` unknown. Tag in parentheses.

| Capability               | Android emulator                                              | Android physical                                  | iOS simulator                     | iOS physical               |
| ------------------------ | ------------------------------------------------------------- | ------------------------------------------------- | --------------------------------- | -------------------------- |
| Tool type (stylus)       | I via `injectInputEvent`; `input stylus` maybe S (device?)    | I; `input stylus` maybe S (device?); R via uinput | ? (private APIs, device?)         | ? (private IOHID, device?) |
| Eraser tool type         | I (doc)                                                       | I (doc); R via `BTN_TOOL_RUBBER` (doc)            | ? (device?)                       | ? (device?)                |
| Pressure                 | I (doc)                                                       | I (doc); R uinput `ABS_PRESSURE` (doc)            | ? (device?)                       | ? (device?)                |
| Tilt / orientation       | I (doc)                                                       | I (doc); R uinput `ABS_TILT_*` (doc)              | ? (device?)                       | ? (device?)                |
| Stylus buttons           | I `buttonState` (doc)                                         | I; R uinput `BTN_STYLUS*` (doc)                   | ? (device?)                       | ? (device?)                |
| Hover                    | I hover events (doc); mouse hover via `input mouse` (device?) | same                                              | X for public API (doc); ? private | ? (device?)                |
| Plain finger touch today | S (code)                                                      | S (code)                                          | S (code)                          | S (code)                   |

CtrlProxy `dispatchGesture` is `X` for every cell in the first four rows
(code + doc).

## Recommended API shape

Add optional fields to the existing coordinate tools rather than new tools:
`tapAt`, `swipeAt`, `dragPath` gain `toolType` (`"finger" | "stylus" | "eraser"`,
default `"finger"`), `pressure` (0..1, the existing `GestureOptions.pressure`
finally wired), and optional `tilt`/`orientation` and `buttons`. `hover` is a
different action shape (position without contact), so it gets its own small tool
(`hoverAt` with `path`/`duration`), not a flag on tap.

Rationale:

- The agent's mental model is "same gesture, different pointer"; tool count and
  schema size already burden `tool-definitions.json`.
- Existing field `pressure` establishes the precedent, and default values keep
  every current call unchanged.
- Capability varies by device, so the response and `observe`/`doctor` should
  report a `pointerInput` capability set (`stylus`, `pressure`, `hover`, route
  name). A request the device cannot honour must fail with an `ActionableError`
  naming the missing route, never silently degrade to a finger touch.
- Android routes behind one interface (`PointerInjector`: `ctrlproxy-a11y`,
  `adb-input-source`, `instrumentation`, `uinput`), chosen by required
  features: finger-only requests keep the fast CtrlProxy path. Needs an
  interface plus a fake for deterministic unit tests, per repo convention.
- Tilt and buttons stay Android-only fields until iOS can honour them; the
  schema marks them platform-limited.

## Recording representation

Today `GestureEvent` has `tap | doubleTap | longPress | swipe | pinch |
pressButton` and drops pressure. Proposed additive changes:

1. Extend `getevent` parsing: track `BTN_TOOL_PEN`/`BTN_TOOL_RUBBER`,
   `BTN_TOUCH`, `BTN_STYLUS`/`BTN_STYLUS2`, `ABS_PRESSURE` and `ABS_MT_PRESSURE`,
   `ABS_TILT_X/Y`, `ABS_DISTANCE`, `ABS_MT_TOOL_TYPE`. Make `discoverTouchNode`
   return all digitizer nodes (pen digitizers commonly appear as a separate
   node).
2. Add per-gesture optional fields: `toolType`, `pressure` (min/max/mean or a
   sampled array for strokes), `tilt`, `buttons`. Existing finger recordings
   keep their shape.
3. Add event types `hover` (path of positions, `distance`) and `stroke` (a
   stylus path with per-point pressure), because a pen drag with varying
   pressure is not faithfully a `swipe`.
4. Replay maps these to the tool fields above; if the target route cannot
   honour them, replay fails loudly rather than degrading.

`BTN_TOOL_PEN` without `BTN_TOUCH` is the hover signal in raw Linux input, so the
recorder can see hover on real pen hardware even when injection is impossible. [doc]

## Experiments that settle the unknowns

1. `adb shell dumpsys input` on an API 34+ AVD and a physical pen device: list
   devices, sources and motion ranges (emulator stylus capability).
2. Run `input stylus swipe` / `input stylus motionevent` against a probe view
   logging `toolType`, `source`, `getPressure()`, `AXIS_TILT`: confirms what the
   `input` command sets.
3. Probe `input mouse motionevent MOVE` for hover events and their
   `toolType`/`source`.
4. Minimal `am instrument` APK that calls `UiAutomation.injectInputEvent` with a
   stylus `MotionEvent` (pressure, tilt, button, hover): confirms the full route
   and measures startup cost.
5. On a rooted device or userdebug AVD, create a `uinput` pen device and verify
   the framework treats it as `SOURCE_STYLUS` with ranges; confirm the recorder
   round-trips it.
6. iOS: dump `XCPointerEventPath` / `XCSynthesizedEventRecord` method lists with
   the Objective-C runtime on the pinned Xcode, and test whether any selector
   changes `UITouch.force` or `UITouch.type` in a probe app on an iPad
   simulator.

## Proposed follow-up issues

1. **Android pointer-injection probe app and experiment results.** Build a
   small Playground screen that logs tool type, source, pressure, tilt, buttons
   and hover for every MotionEvent; run experiments 1-3 and 5 and record results
   in this note.
2. **Android instrumentation injection route (`UiAutomation.injectInputEvent`).**
   Prototype a shell-identity injector (instrumentation APK or `app_process`
   dex) supporting tool type, pressure, tilt, buttons and hover; measure startup
   latency and failure modes.
3. **`PointerInjector` interface and capability reporting.** Introduce the
   interface plus fakes, a per-device `pointerInput` capability set, and
   actionable errors when a requested feature has no route.
4. **Add `toolType` and `pressure` to tapAt/swipeAt/dragPath.** Wire the unused
   `GestureOptions.pressure`, extend schemas and `tool-definitions.json`, route
   stylus requests off the accessibility path.
5. **`hoverAt` tool for Android.** Hover enter/move/exit via the chosen route,
   with duration and path; document mouse vs stylus hover semantics.
6. **Recorder: pen axes and tool type.** Parse `BTN_TOOL_PEN/RUBBER`,
   `BTN_TOUCH`, `ABS_PRESSURE`, `ABS_TILT_*`, `ABS_DISTANCE`; discover separate
   pen nodes; carry pressure into `GestureEvent`.
7. **Recorded stylus gestures: `stroke`/`hover` event types and replay.**
   Define the wire shape, update the classifier and the replay path with strict
   unsupported-feature failures.
8. **iOS private-API probe for pressure/pencil.** Enumerate the pointer-path
   selectors on the pinned Xcode, test force/type on an iPad simulator, and
   decide whether to add a probed, fallback-guarded path.
9. **iOS physical device pencil/hover feasibility.** Assess IOHID digitizer
   injection and entitlements; likely outcome is "document as unsupported".
10. **uinput pen device for rooted devices and userdebug emulators (optional).**
    Only if the instrumentation route proves insufficient for fidelity or
    record/replay symmetry.
