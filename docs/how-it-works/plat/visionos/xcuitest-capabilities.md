# visionOS XCUITest capability boundary

An XCUITest runner drives a window app on the Apple Vision Pro simulator. This page covers what
the runner can observe and act on, and what it cannot.

## Device and tool scope

- Vision Pro simulators are platform `visionos`, form factor `xr-headset`, with independent
  discovery and ownership claims. iOS inventories exclude xrOS runtimes.
- `listDevices`, `listDeviceImages`, `provisionDevice`, `deleteDevice`, `startDevice`,
  `setActiveDevice` and `killDevice` use `simctl`; boot binds a session at `booted` readiness.
  Provisioning accepts only readiness `none`.
- `installApp`, `uninstallApp`, `launchApp`, `terminateApp` and `listApps` use `simctl`.
  Screenshots use `simctl`.
- `observe`, `tapOn` and `sendKeys` prepare a separate window-app XCUITest runner on demand.
- All other device tools are disabled.

## Runner target and observation

- The runner reports hierarchy and focus for the window app last launched with `launchApp`.
- Every projection, including the default, exposes `hierarchyBundleId`: the bundle ID the runner
  that returned the hierarchy was launched with, recorded beside that client in the
  `visionosRunners` registry at registration. It is neither the hierarchy's `packageName` (the
  snapshot identifier, which can be empty for an app) nor the latest `launchApp` target:
  `launchApp` does not restart a connected runner, and a connect-only read of a device another
  session holds reuses it as is, so the two can differ.
- `hierarchyBundleId` is omitted when the runner was started or registered without a target, when
  the hierarchy is unavailable, and on other platforms.
- The runner's app can differ from the app in the screenshot when another app was brought forward
  outside `launchApp`; compare them and relaunch with `launchApp` to switch.
- Taps target enabled window and ornament elements by identifier, narrowed by exact type and label
  when shared (disabled twins never count as sharers). Text is appended to a focused field. A
  missing or disabled target is an invalid `identifier` parameter; remaining ambiguity is
  `ambiguous_element`.
- A runner automating its own host app is restarted (reinstalling that app) when the host app is
  gone: `uninstallApp` marks it; a removal outside that tool is detected when a runner command
  reports the host app not running or not installed (retried once), or when `launchApp` of the
  host bundle finds it not installed (launched once more). A runner the lifecycle does not own is
  never restarted.

## Environment

Launch uses `xcodebuild test-without-building` with `platform=visionOS Simulator,id=<udid>`.
Use device type `Apple-Vision-Pro-4K`: on the `xrOS-26-5` runtime `simctl create` rejects the
listed `Apple-Vision-Pro` type as incompatible. The table below was captured with a probe app
(3×3 button grid `B00`…`B22`, status label, text field `field`, bottom-ornament button `orn`, a
volumetric window, and an empty immersive space); the verbatim capture is
`test/fixtures/visionos-xcuitest/probe-capture.json`.

## Capability table

| Check                        | Result        | Evidence and limits                                                                                                                                                                                               |
| ---------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launch                       | Yes           | `build-for-testing` then `test-without-building` runs the test. One test took about 38 s, including app launch.                                                                                                   |
| Hierarchy                    | Yes           | `descendants(matching: .any)` returns type, identifier, label, frame, `hasFocus` and `isEnabled` for 32 elements. The window frame is 1680×1328 in the capture.                                                   |
| Focus                        | Yes           | `field` reports `hasFocus: false` at launch and `true` after the tap and typing. Focus is reported after interaction, not at launch. It is read from the snapshot, not set.                                       |
| Element tap in window        | Yes           | `app.buttons["B01"].tap()` changes the label to `last: B01`.                                                                                                                                                      |
| Element tap in ornament      | Yes           | `app.buttons["orn"].tap()` changes the label to `last: orn`. The ornament's reported frame is `(16, 16)` in the scene's top-left space, not its visual position at the bottom. Tap by identifier, never by frame. |
| Text input                   | Yes           | `field.tap()` then `field.typeText("hello")` sets the value to `hello`.                                                                                                                                           |
| Immersive space open         | Partial       | A button calls `openImmersiveSpace` and the tap completes without error. The immersive content is empty, so the capture cannot show whether content is visible or appears in the hierarchy.                       |
| Volumetric window            | Not tested    | The volumetric window was declared but never opened.                                                                                                                                                              |
| Window move or resize        | Not shown     | A press-and-drag on the window's bottom edge left the frame origin at `(0, 0)`. That is no evidence of movement. Resize was not tried.                                                                            |
| Gaze, pinch, drag as input   | Not available | No XCUITest API for gaze or hand gestures was found. Only a standard drag was tried.                                                                                                                              |
| Screenshot from `XCUIScreen` | No            | `XCUIScreen.main.screenshot()` returned a 1×1 PNG on this runtime.                                                                                                                                                |
| Screenshot from `simctl`     | Yes           | `xcrun simctl io <udid> screenshot` writes a 3840 px wide PNG. The runner should use this path.                                                                                                                   |

Runner logs include repeated `AXLoading` errors for a missing `SpringBoardUIServices`
accessibility bundle in the runtime; they do not fail the run. The daemon forwards the runner's
stdout and stderr to its debug log.

## Runner readiness and budgets

The runner binds its socket only after it has activated the target app, and
sends its `connected` handshake on each accepted connection. Startup treats that
handshake as ready (5 s per connection attempt, retried within a 60 s startup
limit); it does not request a hierarchy, because the first hierarchy for a built-in app such as
Settings or Safari can take about 8 s (#17199). Hierarchy requests default to a 20 s budget; taps
and text input keep 5 s.

A target app process launched before the runner can fail `snapshot()` with
`Error getting main window kAXErrorAPIDisabled` even while Settings and other
apps on the same simulator remain accessible. For `request_hierarchy` only,
the runner matches that marker in the error description, terminates and launches
the target app once, then retries the snapshot once (#17448). Relaunching can
reset the app's transient state. Other errors do not trigger a relaunch; if the
retry fails, its error is returned.

A runner error containing `kAXErrorAPIDisabled` maps to
`accessibility_api_disabled`, with the runner's error preserved as `cause`.
It means this app's accessibility window could not be read, not that
accessibility is unavailable across the simulator. Only a `request_hierarchy`
message says the app was relaunched; a tap or text input message says no
relaunch happened and to observe (which relaunches once) before retrying. Other
apps may still work; use a screenshot from `simctl` to see the affected app.

## Unproven capabilities

Commands are limited to hierarchy with focus, element taps in the window and ornaments, text
input, and `simctl` screenshots (`XCUIScreen` returns a 1×1 image). Each of these needs its own
probe before a command depends on it:

- Immersive-space content visibility in the hierarchy (the probe must render visible content,
  then check the snapshot and a screenshot).
- Volume window placement and interaction.
- Window move and resize: no move command until a probe shows the frame actually changes.
- Gaze and pinch: treated as not scriptable from XCUITest.

## Background

- [visionOS XCUITest runner scope](../../../devlog/2026-11-04-xcuitest-capabilities-visionos-runner-scope.md)
