# Stylus, pressure and hover injection spike

- Kind: decision
- Date: 2026-10-19
- Source: moved from `how-it-works/mcp/stylus-pressure-hover-injection.md`; #12539, #6335, #13082,
  #13096, #13097, #13098, #13099, #13101, #13103, #13105, #16028, #13093
- Shaped: [Stylus, pressure and hover injection](../how-it-works/mcp/stylus-pressure-hover-injection.md)

## Context

Research spike #12539: what each platform can inject beyond a plain finger touch (tool type,
pressure, tilt, stylus buttons, hover, eraser), and how AutoMobile should expose and record it.
At the start of the spike:

- CtrlProxy built `GestureDescription.StrokeDescription(path, start, duration[, willContinue])`
  and called `dispatchGesture`; only a `Path` and timing went in. `dispatchGesture` events were
  reported to arrive as `TOOL_TYPE_UNKNOWN`, which some apps (DocumentsUI) ignore (#6335).
- The adb fallback (`src/features/action/touchscreenInput.ts`) hard-wired the `touchscreen` source.
- `GestureOptions.pressure` (`src/models/GestureOptions.ts`) had no readers.
- The iOS runner's `ObjCExceptionCatcher.h` declared seven private selectors, none for pressure,
  hover or Pencil. Non-touch IOHID injection had precedent (keyboard events in
  `GesturePerformer+HardwareButtons.swift`; the hinge-angle event in `DefaultHingeAngleSetter.swift`).
- Candidate Android routes also included hidden `InputManager.injectInputEvent` (`INJECT_EVENTS`
  signature permission, reachable via `app_process` as shell uid, greylisted on recent releases).
  Another was `sendevent` into an existing `/dev/input/eventN` node (root, slow per-line events,
  useful only if the digitizer already advertises pen axes).

## Options

API shape:

- Optional pointer fields on the existing coordinate tools (`tapAt`, `swipeAt`, `dragPath`) plus a
  small `hoverAt` tool.
- New tools per input kind (not chosen).

Android routes behind one interface, chosen by required features: `ctrlproxy-a11y`,
`adb-input-source`, `instrumentation`, `uinput`, emulator gRPC.

## Decision

- **Same gesture, different pointer.** Pointer fields go on the coordinate tools rather than new
  tools: tool count and schema size already burden `tool-definitions.json`, and defaults keep
  current calls unchanged. A stylus has no accessibility-element meaning, so element tools do not
  take it. `hoverAt` is its own tool because hover has no contact.
- **Capability flags, never a silent downgrade.** Following the CtrlProxy `*_v1` convention
  (`gesture_display_id_v1`, `multi_finger_gesture_v1`), the runner advertises `stylus_input_v1` /
  `hover_input_v1`; a request needing one is refused before dispatch on older APKs. A host-side
  `pointerInput` summary is derived from the flags and chosen route, never a second source of
  truth. Tilt and buttons stay Android-only until iOS can honour them.
- **iOS simulator (#13103): no-go** for pressure, tool type, tilt, eraser and buttons. Hover was the
  only go: a mouse pointer path (public `hover()` first, private mouse selectors as fallback)
  behind a runner `hover_input_v1` flag absent when neither resolves.
- **Instrumentation route (#13097): GO.** On an API 37 `google_apis` userdebug AVD the Pointer
  Probe (#13096) received strokes as `TOOL_TYPE_STYLUS`, source `STYLUS(0x4002)`, with planned
  pressure and tilt, orientation, and `buttons: 32` as `STYLUS_PRIMARY`. Non-root hover arrived as
  STYLUS, or MOUSE with tool `"mouse"`.
- **uinput route (#13105): PASS** on Android 17 / API 37 userdebug: `SOURCE_STYLUS` with X/Y,
  normalized PRESSURE 0..1, ORIENTATION, DISTANCE and TILT 0..1.571 radians, without idc/keylayout
  files. The probe received pressure 0.98 from raw 4000/4095, tilt 0.55 and `STYLUS_PRIMARY` (32).
  A production `uinput` route was conditional on a need for rooted-device or userdebug-emulator
  record/replay symmetry; instrumentation is the replay route.

## Consequences

- Route selection (#13098), the uinput route (#13105), the instrumentation route (#13097), rich
  stylus on `tapAt`/`swipeAt`/`dragPath` (#13099) and recorder pen parsing (#13101) followed.
- Instrumentation latency on a loaded API 37 AVD host: a one-point hover took 132-162 ms from
  `am instrument` start to exit, injection itself 3-10 ms. A 1 s, 65-event stroke ran in 1.1-2.1 s.
  These are not a budget.
- Planned recorder work at the time: surface `distance`, a sampled `pressure` array for strokes,
  and new `hover` and `stroke` event types, with replay failing loudly if a route cannot honour
  them.
- Open experiments at the time:
  - a physical pen device;
  - a rooted physical device's `uinput` pen;
  - emulator gRPC pen and console `event send` against the probe;
  - on a physical iPad, `pressDownWithPressure:atOffset:` and raw `XCPointerEvent.pressure` against
    `UITouch.force`. An IOHID digitizer event through the `dlsym` pattern was not tried; Pencil also
    needs entitlement checks.
- #16028 stayed open for device acceptance of the stuck-pointer host protection.
