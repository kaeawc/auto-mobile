# watchOS XCUITest spike

The XCUITest runner approach supports hierarchy, tap, and screenshot operations
on the watchOS simulator, as demonstrated with Xcode 26.6, watchOS 26.5, and an
unpaired Apple Watch Series 11 (46 mm) simulator. The probe app is a SwiftUI app
with a counter button, a Crown value, and rows in a scroll view.

## Capability boundary

| Check                  | Result                           | Evidence and limits                                                                                                                                                                                                                                                                                |
| ---------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launch                 | Yes                              | `xcodebuild test-without-building` with `platform=watchOS Simulator` runs the service-style test.                                                                                                                                                                                                  |
| Socket                 | Yes                              | A runner `NWListener` on port 4199 exchanges ping/pong with the host over shared loopback. `TEST_RUNNER_AM_PORT=4199` arrives as `AM_PORT`; `SIMCTL_CHILD_*` was not tested.                                                                                                                       |
| Hierarchy              | Yes                              | `snapshot()` returns frames, labels, identifiers, and element types. `debugDescription` also works.                                                                                                                                                                                                |
| Tap and press          | Yes                              | Element tap, coordinate tap, and coordinate `press(forDuration:)` each reach the counter button.                                                                                                                                                                                                   |
| Drag and swipes        | Calls succeed; effect unverified | `press(forDuration:thenDragTo:)` and all four swipe directions return without error; scroll displacement was not read back.                                                                                                                                                                        |
| Home                   | Call succeeds                    | `XCUIDevice.shared.press(.home)` returns without error.                                                                                                                                                                                                                                            |
| Digital Crown rotation | Yes, with Crown focus            | Typed `XCUIDevice` IMP calls change the focused view's bound Crown value. This does not demonstrate scrolling a real `ScrollView`.                                                                                                                                                                 |
| Screenshots            | Yes                              | `XCUIScreen.main.screenshot()` and `simctl io screenshot` both work.                                                                                                                                                                                                                               |
| System apps            | Settings yes; Carousel no        | `com.apple.NanoSettings` activates and snapshots. Launching `com.apple.Carousel` is rejected by `IOSSHLMainWorkspace`.                                                                                                                                                                             |
| CtrlProxy typecheck    | Yes, compilation only            | `Sources/CtrlProxy` typechecks with the sdk-wire module and ObjC catcher module map for `arm64-apple-watchos10.0-simulator`. `os(iOS)`-gated and UIKit-importing paths are compiled out, so they do not demonstrate watchOS behaviour. CtrlProxy itself was neither built with xcodebuild nor run. |

## Installation and runner lifetime

For this standalone watch app, `Info.plist` must contain both `WKApplication = true`
and `WKWatchOnly = true`. `WKApplication` alone fails installation with
`MIInstallerErrorDomain` 97 because a non-watch-only app requires
`WKCompanionAppBundleIdentifier`.

Under load, `test-without-building` can remain running after the test passes.
Use a hard timeout wrapper.

## Digital Crown contract

Rotation reaches the view that holds Crown focus. The demonstrated target uses
`.focusable()`, an `@FocusState` set in `onAppear`, and
`.digitalCrownRotation($crown, from: -1000, through: 1000, by: 0.1,
sensitivity: .high, isContinuous: true, isHapticFeedbackEnabled: false)`.
The test taps the `crown` text before rotation. An unfocused target and
`perform(_:with:)` calls with boxed `NSNumber` arguments did not change the value;
typed `@convention(c)` IMP calls confirm rotation:

| Private selector                          | `@convention(c)` signature                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| `rotateDigitalCrownByDelta:withVelocity:` | `(AnyObject, Selector, Double, Double) -> Void`                            |
| `rotateDigitalCrownByDelta:`              | `(AnyObject, Selector, Double) -> Void`                                    |
| `rotateDigitalCrown:velocity:`            | `(AnyObject, Selector, Double, Double) -> Void` (encoding `v32@0:8d16d24`) |

The app binding's sensitivity, step, continuous range, and velocity affect the
result, and wrapping or clamping makes the delta-to-value mapping nonlinear. A Crown action must
report the **requested delta**, not a resulting position. Guard each private
selector with `responds(to:)` and return a typed unsupported error if absent.

Each call takes seconds, so many small steps exceed a runner timeout. Use **one
call per Crown action**, with a larger delta as needed and its own timeout. An
enclosing `ScrollView` without a Crown binding does not move.

The capture at `test/fixtures/watchos-xcuitest/hierarchy.json` is the original
23-node probe hierarchy, with counter and Crown values at zero. Element types
are `XCUIElement.ElementType` raw values.

## Decision

**GO** for CtrlProxy-dependent children on hierarchy, tap, and screenshot.
Crown rotation is demonstrated, with no further device questions for this
spike; scrolling a real `ScrollView` by Crown remains untested and is an
implementation follow-up. The `os(iOS)`-gated input paths need watchOS
implementations, and device acceptance after merge remains required. Physical
watches and changes to the iOS CtrlProxy test target are out of scope.
