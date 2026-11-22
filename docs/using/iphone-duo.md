# iPhone Duo simulator

The iPhone Duo simulator has two panels: a cover screen when folded and an inner screen when
opened. Switch between them with `setPosture` (for example `posture: "opened"`); `observe` then
reports the active panel. When Simulator shows each panel in a separate window, `highlight`
uses the panel matching the highlighted element's source dimensions. If those dimensions cannot
identify a panel, it uses the focused panel when both panel displays can be identified. Duplicate
windows with the same display proportions remain ambiguous; close duplicate windows and retry.

## OS version in session-broker requests

The iPhone Duo simulator needs a newer iOS runtime than the phones and tablets a host
usually pins. When a session-broker request omits `os`, the host's `defaults.ios.os` applies
to every device type, so an exact 26.5 default fails a Duo request with
`runtime_incompatible`; the error names `defaults.ios.os.archetypes`. Give Duo its own
default in the host configuration without changing the others:

```json
"os": {
  "selector": { "kind": "exact", "version": "26.5" },
  "preferredVersion": "26.5",
  "archetypes": [
    { "archetype": "duo", "selector": { "kind": "exact", "version": "27.1" }, "preferredVersion": "27.1" }
  ]
}
```

Each archetype (`phone`, `tablet`, `duo`) may appear at most once; a duplicate fails config
loading. An entry applies only when the request omits `os`; a request that passes an `os`
selector gets exactly that selector. Alternatively, pass `os` in the Duo request.

To check a host before sending it a request, call `getSessionRequirementCapability` with the
request's `device`. It acquires nothing. With `os` omitted it reports the OS the host's
default resolves to and whether that runtime is installed:

```bash
auto-mobile --cli getSessionRequirementCapability --device '{"schemaVersion":1,"platform":"ios","hardware":{"kind":"model-type","modelType":{"family":"duo","variant":"duo"}},"os":{"kind":"omitted"}}'
```

| Field                                   | Meaning                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `resolvedOs`                            | `source` (`request`, `device-type-default` or `platform-default`), the effective `selector`, and `osVersion`/`runtime` when satisfiable.                     |
| `satisfiable`, `reason`                 | Whether an installed runtime and device type can serve the request now; otherwise the refusal code (`missing_installed_runtime`, `runtime_incompatible`, …). |
| `defaultOsSatisfiable`                  | The same hardware with `os` omitted is satisfiable on this host.                                                                                             |
| `anyOsSatisfiable`, `installedRuntimes` | The installed runtimes that can run the hardware when named exactly.                                                                                         |
| `policyVersion`                         | The host defaults policy that produced the answer.                                                                                                           |

A host without iOS tooling answers `success: false` with `code: "catalog_unavailable"`; a daemon
not running the session broker answers `code: "session_broker_unavailable"`.

## Reading the posture with `getDeviceState`

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

Call `setPosture` with `hingeAngle` (0 to 180 degrees). The result returns `hingeAngle` as requested
and no `observedHingeAngle`, because the runner cannot read the angle apps see.

The result's `posture` follows the same rules as `getDeviceState` above: cover `closed`, inner
`half_opened` or `opened`. When AutoMobile cannot determine the active panel, `posture` is `unknown`
with a `postureReason`.

The simulator's panel switch depends on the angles it passed through, not only on the final angle.
For example, `0 -> 80 -> 120` leaves the cover panel active and apps on the closed layout. A direct
`0 -> 120` switches to the inner panel.

The active panel can contradict the requested angle: cover panel at 90 degrees or above, or inner
panel at 0 degrees. The call then waits up to 3 seconds for the panel to switch. If it still
disagrees, the call succeeds and adds a `warnings` entry.

To recover a cover panel that should be open, set `hingeAngle` 180, then the target angle again,
and `observe` before acting. Below 90 degrees the cover panel is a normal result. Strictly between
0 and 90 degrees, either panel is plausible.

## Screen geometry after a posture change

After a posture change, `setPosture` checks that the runner and `observe` agree on the screen's
orientation and size, and waits up to 10 seconds for them to agree. If they still disagree, the
posture change still succeeds, but the result's `warnings` list names the mismatch, for example:

```text
Screen geometry is still inconsistent 10000 ms after the posture change: observe reports rotation 0 and 669x951, but elements are laid out for 951x669. Taps may land in the wrong place; observe again before tapping.
```

When you see this warning, call `observe` again before you tap. If taps still miss, open a screen
on the inner display first (for example switch tabs), then observe and tap.

`tapAt` and `tapOn` refuse to tap when the latest observation contradicts itself: the reported
screen is portrait, but the elements are laid out for the landscape size. Nothing is tapped, and
the error reads:

```text
Screen geometry is stale after a posture change: observe reports rotation 0 and 669x951, but elements are laid out for 951x669. Nothing was tapped. Observe again, then retry.
```

Call `observe`, then retry the tap. Apps that are laid out for the reported size, in portrait or
landscape, are tapped as usual.

## Rotating a panel

`rotate` turns whichever panel is active, in every posture. The inner panel is landscape when the
device is upright, so `orientation: "portrait"` there gives a 669x951 layout and `"landscape"`
gives 951x669; Settings rotates on the inner panel too. The home screen on the inner panel turns
on screen, but reports a size that does not follow it, so `rotate` there can fail with "does not
rotate on the inner panel"; open an app with `launchApp` and rotate inside it. On the cover panel,
apps that support landscape (for example Safari) rotate, but Settings and the home screen stay
portrait, and `rotate` fails with:

```text
The foreground app or screen does not rotate on the cover panel (the screen size did not change). Open the device to its inner panel (unfold the hinge) and retry there, or keep the current orientation.
```

After a failed rotate the previous orientation is put back, so the next app does not open rotated.

Rotating a panel works only on the iOS Simulator. On a physical iPhone Duo, `rotate` changes
nothing and fails with:

```text
Rotating an iPhone Duo panel is only supported on the iOS Simulator; it has not been verified on a physical device.
```

## Home-screen icons after an unfold

After an unfold, the home screen reports app icon positions that do not match what it draws. As a
result, `observe` on the home screen can omit visible icons (for example Settings) or report an
icon at the wrong position. A `tapOn` by an icon's label can fail with "Element not found" or tap
the wrong place. Only app icons suffer this; AutoMobile reports the dock, status bar and other
home-screen controls correctly.

To open an app on the iPhone Duo, call `launchApp` with its bundle ID instead of tapping its
home-screen icon:

```json
{ "name": "launchApp", "arguments": { "appId": "com.apple.Preferences", "platform": "ios" } }
```

## Screenshots that cannot be verified

AutoMobile does not return a screenshot that may show the dark panel. That applies when it cannot
tell which panel is active, or cannot read the fallback screenshot's size to check it against the
active panel. The screenshot fails with `Runner screenshot could not be verified`. Call `observe`
again so the active panel is known, or check the posture with `setPosture`.
