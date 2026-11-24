# `tapAt`

| Tool                  | What it does                                                                                 | Platforms                                                                                                                                                                                                                   | Needs                             |
| --------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 📍 <code>tapAt</code> | Tap, long press, or double tap at screen coordinates in native, normalized, or percent units | <span class="tool-platforms"><span role="img" aria-label="Android" title="Android">🤖</span> <span role="img" aria-label="iOS" title="iOS">🍎</span> <span role="img" aria-label="watchOS" title="watchOS">⌚</span></span> | <span class="tool-needs">—</span> |

`tapAt` taps, long presses, or double taps at `x`, `y`. Absolute coordinates use
platform-native units; `coordinateSpace: "normalized"` uses 0–1 and `"percent"`
uses 0–100. Alternatively, pass `image` with a screenshot-relative point and its
image metadata.

On iOS, a successful tap with a post-tap observation includes `effect: { screenChanged, basis }`, comparing observations for evidence of a screen change.
On iOS, `dispatchRoute` names the route that took the tap. The runner reports routes such as `xcuiCoordinate` or `displayTargetedRecord`. It is omitted when unreported.
The `tapOn` tool reports the same optional `dispatchRoute` for iOS coordinate taps, double taps and long presses. It is omitted for taps performed by VoiceOver activation or the SDK bridge.

On an iOS Simulator held upright in portrait, taps and long presses go to the simulator's own touch input, and `dispatchRoute` is `simulatorHid`. They skip the runner's idle wait and its stale-frame check. A tap within 3 seconds of a launch waits for the rest of those 3 seconds.

Double taps, taps on a named display, landscape and upside-down screens use the runner. The runner also takes taps while the input helper starts or is unavailable. These runner taps keep the idle wait and the stale-frame check. If the runner cannot be reached, the tap waits for the helper to start and uses it.

If Xcode cannot compile the helper, input uses the runner and the build is not retried for 30 minutes. Other build failures, such as a failed `codesign` or `xcrun` call, retry after 30 seconds. Ending the device session also clears the wait. Set `AUTOMOBILE_DISABLE_IOS_SIM_HID=1` to always use the runner.

## Android XR

On an Android XR headset in home space, coordinates are screenshot pixels.
For a standard (task-aligned) app panel, choose a point inside the topmost app
panel in the screenshot. Normalized, percent, and image inputs resolve to the
same screenshot space. The result's `xrPanel` identifies the app and task and
reports `displayX`, `displayY`, the mapped display pixels used for input; `x`,
`y` also report that dispatched point.

A point outside the panel fails with “no app panel under that screenshot point”
and no `warning`. The tool cannot tap XR system UI, including the home-space
launcher and environment buttons. Open an app panel, observe again, and choose a
point inside its screenshot projection.

This mapping supports the default headset pose in home space; moved panels and
immersive apps are outside its scope. Every successful XR mapping carries a
`warning` that coordinates assume the default panel pose. If the panel was moved
or scaled, keep it in its default position (or reopen the app), observe again,
and retry.

When more than one app panel is open, or the panel cannot fit the screenshot at
the default pose, `tapAt` refuses before tapping. Close the other panels or
restore the panel, then observe again.

Apps whose content is a Compose spatial panel cannot receive coordinate taps.
The tool refuses them wherever the panel sits, with “XR spatial-panel input
injection is unsupported”; moving, reopening, or re-observing does not help.
Use `tapOn` or `tapAny`, which click the accessibility node, or move keyboard
focus with `focusNavigate` (or `sendKeys` arrow keys) and press `enter`.
