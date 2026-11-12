# Stylus, pressure and hover injection

How AutoMobile injects input beyond a plain finger touch (tool type, pressure, tilt, stylus
buttons, hover, eraser) and how it records it. Platform evidence for each input path is in
[Pressure, hover and stylus input](../plat/pressure-hover-stylus-input.md).

## Tool contract

- Stylus input is the optional nested `pointer` option on the coordinate tools `tapAt`, `swipeAt`
  and `dragPath`; the element tools (`tapOn`, `swipeOn`) do not take it. Defaults keep finger
  calls unchanged.
- `hoverAt` is a separate tool (no contact). It reuses the `dragPath` point schema (per-point
  `durationMs`, optional `distance`) and the `coordinateSpace`, `display`, `snapshotId` and
  `layer` fields.
- A request a device or route cannot honour is refused before dispatch with the missing
  capability named. It never degrades to a finger touch.
- iOS has no stylus or hover route: the runner advertises neither `stylus_input_v1` nor
  `hover_input_v1`, and such requests are refused before dispatch.
- `src/utils/disableStylusHandwriting.ts` runs `settings put secure stylus_handwriting_enabled 0`
  so injected touches are not treated as handwriting.

## Route selection

`src/features/action/pointer/` holds the `PointerInjector` interface and four routes, tried in
this order:

| Route              | Carries                                                                                 | Gate                                              |
| ------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `ctrlproxy-a11y`   | Finger only                                                                             | CtrlProxy accessibility service                   |
| `adb-input-source` | Constant-pressure stylus                                                                | API 31+                                           |
| `instrumentation`  | Stylus pressure, tilt, orientation, buttons; stylus or mouse hover                      | Runner flags `stylus_input_v1` / `hover_input_v1` |
| `uinput`           | Stylus pressure, tilt, orientation, barrel buttons, eraser, hover through a virtual pen | `adb shell` already running as root               |

- `selectPointerRoute` takes the first supporting route, so finger touches keep the accessibility
  path. A request no route can honour is refused before dispatch with the missing capability
  named; contradictory requests (a finger hover, hover with pressure, a mouse click) are refused
  as invalid.
- `derivePointerInput` reports, per feature, the route that would carry it, from the same support
  data; it is never a second source of truth.
- The `emulator-grpc` route id is reserved and not wired.

## uinput route (#13105)

The last route, for emulators and rooted devices: taken only when `adb shell` already runs as uid 0
(`id -u`), so a runner that injects without root always wins. AutoMobile never runs
`adb root` itself, because that restarts adbd.

**Shape.** `uinputPenScript` writes the command script Android's `uinput` tool reads: a `register`
of the pen the probe verified (`INPUT_PROP_DIRECT`; `BTN_TOOL_PEN`, `BTN_TOOL_RUBBER`, `BTN_TOUCH`,
`BTN_STYLUS`, `BTN_STYLUS2`; `ABS_X`/`Y` sized to the display in rotation 0, a `wm size` override winning over the physical size, `ABS_PRESSURE` 0..4095,
`ABS_DISTANCE` 0..255, `ABS_TILT_X`/`Y` ±90), a 4 s wait for the device to attach, then the request as frames every 16 ms with the instrumentation planner's interpolation. A
stroke is `BTN_TOOL_PEN` (`BTN_TOOL_RUBBER` for an eraser) and `BTN_TOUCH` down with pressure,
then touch up and the tool out. Tilt and orientation interpolate per frame and invert InputReader's
mapping into integer-degree `ABS_TILT_X`/`Y` values, including the opening frame; strokes with neither tilt nor orientation emit
no tilt events. Barrel masks 32 and 64 press `BTN_STYLUS` and `BTN_STYLUS2` before the opening
`SYN_REPORT` and release before `BTN_TOUCH` up. A hover is
`BTN_TOOL_PEN` in range with `ABS_DISTANCE` and no `BTN_TOUCH`. Screen points in the current rotation
map to natural-orientation digitizer coordinates by inverting the recorder's touch mapping
(`buildScaler`). The host pipes the script through base64 into `uinput -` on the device and reads
the tool's exit status back from a marker line; the device closes the pen when the tool exits.

**Limits.**

| Case                                               | Behaviour                                                         |
| -------------------------------------------------- | ----------------------------------------------------------------- |
| Tilt, orientation or barrel buttons                | Encoded for contact strokes; refused for hover                    |
| Eraser                                             | Only this route injects one; the instrumentation route refuses it |
| A display other than 0                             | Refused, nothing sent                                             |
| Rotation or `wm size` unreadable                   | Refused, nothing sent                                             |
| No `uinput` tool, or `/dev/uinput` not writable    | Refused, nothing sent, with the fix named                         |
| Any other `uinput` failure                         | Outcome unknown; verify with `observe` before retrying            |
| A script over 100 KB of base64 (about ten seconds) | Refused, nothing sent: adbd runs it as one `sh -c` argument       |

Runs hold one lock per device id that the instrumentation route shares, so a pen and an
instrumentation stroke never play at once; it is keyed by device id because every tool call builds
its own adb client. The 4 s attach wait, rotated displays and a pre-API 31 device are
unverified on hardware.

## Instrumentation route (#13097)

`PointerInstrumentation` is the primary route for stylus pressure, tilt, buttons and hover on
API 31+ stock-privilege devices. It uses shell identity and needs no root. Runs are serialised per
device, and the host recovers from a stuck pointer (#16028).

**Shape.** CtrlProxy declares `PointerInstrumentation` (`<instrumentation>` in its manifest). The host
starts it with
`adb shell am instrument -w -r --no-restart -e request <base64 json> dev.jasonpearson.automobile.ctrlproxy/.pointer.PointerInstrumentation`.

**`--no-restart`.** The instrumentation targets CtrlProxy's own package, and `am instrument`
force-stops its target at start and finish unless given `--no-restart`, which would kill the
accessibility service and its WebSocket server. API 30's `am` rejects the flag (`Unknown option:
--no-restart`); API 31, 32, 33 and 37 accept it and keep CtrlProxy's pid and accessibility service
(#13082). CtrlProxy therefore advertises `stylus_input_v1` and `hover_input_v1` only on API 31+
(`PointerInjectionSupport`); an older device is refused with the flags absent, and an `am` that
rejects the flag reports it. Instrumentation shares CtrlProxy's process, so killing either kills
both.

**Run.** The instrumentation validates the request, gets a `UiAutomation` with `FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES`
(without it the system silences CtrlProxy's own accessibility service for the duration), plays the
planned `MotionEvent`s through `injectInputEvent`, and reports `success`, `error`, `injected` and
`elapsedMs` as `INSTRUMENTATION_RESULT` lines. The host side is `createInstrumentationDispatch`.

**Pieces.** `PointerInjectionPlanner` (framework-free: a hover is ENTER, interpolated MOVEs every 16 ms
and EXIT; a stroke is DOWN, MOVEs, UP with pressure, distance, tilt and orientation interpolated
between waypoints) and its validation; `PointerRequestCodec`; `PointerInjectionExecutor` (schedules
events and, if one is refused or throws or the run is cancelled, closes the pointer with CANCEL or
HOVER_EXIT);
`UiAutomationPointerSink` (the only class that touches `MotionEvent`). CtrlProxy advertises
`stylus_input_v1` and `hover_input_v1` (API 31+); `hoverAt` uses the route.

**Failure modes.**

Unsupported requests report errors: `durationMs` outside 0..5000 and tool `"eraser"`
(only `"stylus"` or `"mouse"` is accepted). Killing the process also clears enabled
accessibility services; concurrent runs crash and leave the same state.

| Failure                                                                                                            | Behaviour                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instrumentation not in the installed APK                                                                           | `am instrument` reports it cannot find it; the host says to update CtrlProxy, nothing was sent                                                                                                                                                                                                                                                                    |
| Process killed mid-run                                                                                             | No result is reported; the host says the outcome is unknown and to verify with `observe`. It can also leave a stuck pointer (below).                                                                                                                                                                                                                              |
| An event is refused or throws (including HOVER_ENTER with the screen off) or the run is cancelled                  | The executor closes the pointer with CANCEL or HOVER_EXIT and reports the count injected; an event that threw is closed too, since it may have been delivered. If the close is refused, the host sends a stylus CANCEL. `FLAG_SECURE` behaviour is unverified.                                                                                                    |
| `UiAutomation` unavailable (another UiAutomation client, such as a running UiAutomator test, holds the connection) | Reported as an error before any event                                                                                                                                                                                                                                                                                                                             |
| Non-default display                                                                                                | Refused: routing needs the hidden `setDisplayId`; not implemented                                                                                                                                                                                                                                                                                                 |
| Cold start and per-event latency                                                                                   | Each call starts instrumentation; the host timeout allows twice the planned time plus 15 s. Cold start dominates, and event delivery can lag the plan by up to about 2x on a loaded host. There is no latency budget.                                                                                                                                             |
| Stuck down pointer after a killed or concurrent run                                                                | Device `-1` retains a down pointer; later injections are refused until a stylus CANCEL. The host serialises runs per device. A run that ends without a report (crashed, killed, timed out or aborted by the caller) gets a stylus CANCEL before the lock admits the next run, sent without the caller's signal; a zero-event refusal gets a CANCEL and one retry. |

## Rich stylus on `tapAt`, `swipeAt` and `dragPath` (#13099)

The nested `pointer` option keeps its shape and gains `tilt`, `orientation` (radians) and `buttons`
(`primary`, `secondary`); `pressure` may be any 0..1. A plain stylus (`pressure` omitted or 1) still uses
`adb input stylus`, so existing calls are unchanged. Anything the shell cannot inject, and every stylus
`dragPath` (per-point `pressure` and `tilt`, holds as repeats of the first and last point), goes through
`dispatchRichStylus` and instrumentation or root-only uinput. `strokeRequest` sets only the features the request
needs (`variablePressure`, `extendedAxes`, `path`), so a refusal names the real reason, and the refusal
comes before the display fence and any dispatch hook. A failure after dispatch is
`StylusOutcomeIndeterminateError` (do not retry) unless the route says nothing was sent
(`PointerNotSentError`). `doubleTap` and panel selection are still refused with a stylus.

## Recording export

`recordToolCalls` records AutoMobile tool calls, so pointer params and `hoverAt` ride along in
recorded plans. Injected gestures are not seen by the `getevent` recorder
(`DEVICE_GESTURE_RECORDING_USER_INPUT_ONLY_NOTICE` in `src/daemon/deviceGestureRecordingManager.ts`).

`recordDeviceGestures` exports physical pen input (capture details:
[What the recorder sees](../plat/pressure-hover-stylus-input.md#what-the-recorder-sees)):

- A pen tap, long press or swipe exports as `tapAt`/`swipeAt` with `pointer.toolType: "stylus"`
  and normalized mean contact `pressure`, mean `tilt` (radians) and `buttons` (`primary`,
  `secondary`, held at any point during contact). Empty buttons are omitted. These scalars
  summarize the contact, not its pressure ramp or button timing.
- Pressure and tilt use four decimal places, tilt clamped to PI/2 after rounding. Pressure is
  omitted without a known axis range or non-zero measurements.
- Tilt subtracts each axis range's midpoint, scales by the reported units-per-radian resolution
  (PI/180 when resolution is zero or absent), then takes Android's
  `acos(cos(xAngle) * cos(yAngle))` magnitude. It is omitted unless samples and valid axis ranges
  exist.
- Varying-pressure strokes export as `dragPath`; positioned hover exports as `hoverAt`; an eraser
  exports as an eraser step with a warning that only the uinput route replays it.

## Pointer Probe

The Playground **Pointer Probe** screen verifies routes. Open it from Home > Demos > Pointer Probe
or `adb shell am start -a android.intent.action.VIEW -d automobile://playground/demos/input/pointer_probe`
(app onboarded and logged in).

- A custom View logs every `MotionEvent` from `onTouchEvent`, `onHoverEvent` and
  `onGenericMotionEvent`: callback, action, `deviceId`, `source`, `buttonState`, per-pointer
  `toolType`, `getPressure()`, `AXIS_TILT`, `AXIS_ORIENTATION`, x/y.
- The newest 20 lines are Text nodes `pointer_probe_event_0` (newest) to `pointer_probe_event_19`;
  `pointer_probe_count` is the running total and `pointer_probe_clear` empties the log, so
  `observe` can read results.
- A hover reaching both the View and the Compose hover fallback is logged once (copies matched by
  `deviceId`, action and event time, since their coordinate spaces differ).
- `adb shell dumpsys input` shows devices, sources and motion ranges; check it before relying on
  advertised stylus support on an AVD profile.

## Unverified

- Physical pen devices; a rooted physical device's `uinput` pen.
- `FLAG_SECURE` windows and a UiAutomator test holding `UiAutomation`.
- Multi-display injection (non-default displays are refused).
- Quiet-host latency; the uinput 4 s attach wait, rotated displays and pre-API 31 devices on
  hardware.
- A stylus `tapAt` with pressure reaching the probe with that pressure on a device (#13082).

## Background

- [Stylus, pressure and hover injection spike](../../devlog/2026-10-19-stylus-pressure-hover-injection-spike.md)
