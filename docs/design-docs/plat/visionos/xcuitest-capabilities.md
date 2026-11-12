# visionOS XCUITest capability boundary

An XCUITest runner can drive a window app on the Apple Vision Pro simulator. This
page records what the runner can observe and act on, what it cannot, and the
decision for the visionOS runner in #16852 (Part of #16851).

AutoMobile models Vision Pro simulators as platform `visionos`, form factor
`xr-headset`, with independent discovery and ownership claims. `listDevices`,
`listDeviceImages`, `provisionDevice`, `deleteDevice`, `startDevice`, `setActiveDevice`
and `killDevice` use `simctl`; boot binds a session at `booted` readiness.
`observe`, `tapOn` and `sendKeys` prepare a separate window-app XCUITest runner
on demand. Its xrsimulator xctestrun comes from `AUTOMOBILE_VISIONOS_RUNNER_XCTESTRUN`, then local
`AutoMobileVisionTest` products, then the release's pinned `visionos-runner-macos.zip` through
`VisionosRunnerReleaseProvider` (the tvOS `SimulatorRunnerReleaseProvider` contract), then a
source build. The iOS runner is not reused: visionOS is its own scheme and SDK. Provisioning still accepts only readiness `none`. The runner reports
hierarchy and focus for the window app last launched with `launchApp`. The observation
exposes the bundle ID of the window app the runner automates as `hierarchyBundleId`
with every projection, including the default. It is the target the runner that
returned the hierarchy was launched with, recorded beside that client in the
`visionosRunners` registry when it registers, rather than the hierarchy's `packageName`
(the snapshot identifier, which can be empty for an app) or the latest `launchApp`
target: `launchApp` does not restart a connected runner, and a connect-only read of a
device another session holds reuses it as is, so the two can differ. The field is
omitted when that runner was started without a target or registered without one, when
the hierarchy is unavailable, and on other platforms. This app can
differ from the app in the screenshot when another app was brought forward outside
`launchApp`; compare them and relaunch with `launchApp` to switch. The runner
taps enabled window and ornament elements by identifier (narrowed
by exact type and label when shared; disabled twins never count as sharers), and appends text to a focused field;
a missing or disabled target is an invalid `identifier` parameter, and remaining ambiguity is `ambiguous_element`;
screenshots use `simctl`. iOS inventories exclude xrOS runtimes. `installApp`, `uninstallApp`, `launchApp`, `terminateApp` and
`listApps` use `simctl`. A runner automating its own host app is restarted, which
reinstalls that app, when the host app is gone: `uninstallApp` marks it; a removal
outside that tool is detected when a runner command reports the host app as not running
or not installed (retried once), or when `launchApp` of the host bundle finds it not
installed (launched once more). A runner the lifecycle does not own is never restarted.
All other device tools remain disabled.

## Environment

Xcode 26.6, visionOS 26.5 runtime (`xrOS-26-5`), device type
`Apple-Vision-Pro-4K`. The `Apple-Vision-Pro` device type is listed but
`simctl create` rejected it as incompatible with this runtime. Launch uses
`xcodebuild test-without-building` with `platform=visionOS Simulator,id=<udid>`.

The probe is a throwaway SwiftUI visionOS app with a 3×3 button grid
(`B00`…`B22`), a status label, a text field (`field`), a button in a bottom
ornament (`orn`), a volumetric window, and an immersive space with empty content
(`Color.clear`). Its XCUITest writes its observations to a JSON file. The
verbatim capture is `test/fixtures/visionos-xcuitest/probe-capture.json`.

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

Runner logs include repeated `AXLoading` errors for a missing
`SpringBoardUIServices` accessibility bundle in the runtime. They did not fail
the run. The daemon forwards the runner's stdout and stderr to its debug log.

## Runner readiness and budgets

The runner binds its socket only after it has activated the target app, and
sends its `connected` handshake on each accepted connection. Startup treats that
handshake as ready (5 s per connection attempt, retried within a 60 s startup
limit); it does not request a hierarchy. The first hierarchy for a built-in app
such as Settings or Safari took about 8 s, so a hierarchy-based readiness check
timed out on every attempt (#17199). Hierarchy requests default to a 20 s budget;
taps and text input keep 5 s.

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

## Decision

**GO** for #16852 on the window-app scope: hierarchy with focus, element taps in
the window and in ornaments, text input, and screenshots from `simctl`. Limit the
`observe`, `tapOn` and `sendKeys` commands to these.

Outside the GO scope, each item needs its own probe before a command depends on it:

- Immersive-space content visibility in the hierarchy. The probe must render
  visible content, then check the snapshot and a screenshot.
- Volume window placement and interaction.
- Window move and resize. Do not expose a move command until a probe shows the
  frame actually changes.
- Gaze and pinch. Treat these as not scriptable from XCUITest.

Screenshots must come from `xcrun simctl io <udid> screenshot`, because
`XCUIScreen` returns a 1×1 image on this runtime.
