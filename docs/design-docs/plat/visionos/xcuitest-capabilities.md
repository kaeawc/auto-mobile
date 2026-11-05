# visionOS XCUITest capability boundary

An XCUITest runner can drive a window app on the Apple Vision Pro simulator. This
page records what the runner can observe and act on, what it cannot, and the
decision for the visionOS runner in #16852 (Part of #16851).

AutoMobile models Vision Pro simulators as platform `visionos`, form factor
`xr-headset`, with independent discovery and ownership claims. Only `listDevices`,
`listDeviceImages`, `provisionDevice`, `deleteDevice`, `startDevice`, `setActiveDevice`
and `killDevice` are enabled. Lifecycle operations use `simctl`; boot binds a session
at `booted` readiness without starting an automation runner. iOS inventories exclude
xrOS runtimes. Runner capability evidence below does not enable additional tools.

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
the run.

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
