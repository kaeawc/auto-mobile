# iPhone Duo simulator

The iPhone Duo simulator has two panels: a cover screen when folded and an inner screen when
opened. Switch between them with `setPosture` (for example `posture: "opened"`); `observe` then
reports the active panel.

## Reading the posture with getDeviceState

`getDeviceState` is not listed in `tools/list` by default. A client that picks tools from
discovery must enable it first with
`setToolEnabled` (`{ "toolName": "getDeviceState", "enabled": true }`); see
[Dynamic Tools](dynamic-tools.md). A client can also call it directly by name without enabling it.

`getDeviceState` reports `displays.current` with the active panel (`activePanel`) and a posture
derived from it. AutoMobile cannot read the iPhone Duo hinge:

- Cover panel active: `closed`, `postureSource: "inferred_from_active_panel"`.
- Inner panel active, and the last `setPosture` hinge angle (a named posture sets 0, 130 or 180) was strictly between 0 and 180
  degrees: `half_opened`, `postureSource: "requested_hinge_angle"`.
- Inner panel active otherwise (180 degrees, or no angle set since the AutoMobile daemon
  started): `opened`, `postureSource: "inferred_from_active_panel"`.

`requestedHingeAngle` is the last angle `setPosture` requested. It repeats the request; it is not
a reading of the hinge, and it goes stale if the hinge is changed outside AutoMobile.
Do not treat either source as a confirmed hinge posture. Use `activePanel` to decide which screen
you are on, and call `setPosture` when a test needs a specific posture. When the active panel
cannot be determined, `displays.current` is omitted.

On an Android foldable, `postureSource` is `device_state`: the posture the device itself
committed. When the device cannot report its posture, `posture` is `unknown` and `postureSource`
is omitted.

## Setting a hinge angle

`setPosture` with `hingeAngle` (0 to 180 degrees) returns `hingeAngle` as requested and no
`observedHingeAngle`: the runner cannot read the angle apps see. `posture` follows the same rules as
`getDeviceState` above (cover `closed`, inner `half_opened` or `opened`), or `unknown` with
`postureReason` when the active panel cannot be determined.

The simulator's panel switch depends on the angles it passed through, not only on the final angle.
For example, `0 -> 80 -> 120` leaves the cover panel active and apps on the closed layout, while
`0 -> 120` switches to the inner panel. When the active panel contradicts the requested angle
(cover panel above 90 degrees, or inner panel at 0 degrees), the call waits up to 3 seconds for
the panel to switch; if it still disagrees, the call succeeds and adds a `warnings` entry. To recover a cover panel that should be open, set `hingeAngle` 180, then the
target angle again, and `observe` before acting. Up to 90 degrees the cover panel is a normal
result.

## Home-screen icons after an unfold

After an unfold, the home screen reports app icon positions that do not match what is drawn. As a
result, `observe` on the home screen can omit icons that are visible (for example Settings) or
report an icon at the wrong position, and `tapOn` by an icon's label can fail with "Element not
found" or tap the wrong place. This affects app icons only; the dock, status bar and other
home-screen controls are reported correctly.

To open an app on the iPhone Duo, call `launchApp` with its bundle ID instead of tapping its
home-screen icon:

```json
{ "name": "launchApp", "arguments": { "appId": "com.apple.Preferences", "platform": "ios" } }
```

## Screenshots that cannot be verified

When AutoMobile cannot tell which panel is active, or cannot read the size of the fallback
screenshot to check it against the active panel, it does not return a screenshot that may be of
the dark panel. The screenshot fails with `Runner screenshot could not be verified`. Call `observe`
again so the active panel is known, or check the posture with `setPosture`.
