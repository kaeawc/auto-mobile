# watchOS XCUITest spike

The XCUITest runner approach supports hierarchy, tap, and screenshot operations
on the watchOS simulator. The probe uses Xcode 26.6 (17F113), watchOS 26.5
(23T570), and an unpaired Apple Watch Series 11 (46 mm) simulator on an arm64
host. The Crown probe host runs macOS 26.6.2. Timings are indicative: host load
averages were 120–500. The SwiftUI app exposes a counter button, a Crown value,
and rows in a scroll view.

## Capability boundary

| Check                  | Result                           | Evidence and limits                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launch                 | Yes                              | `xcodebuild test-without-building` with `platform=watchOS Simulator` runs the service-style test. App launch takes 3.2 s and simulator boot 21 s. A separate warm-launch timing is not recorded.                                                                                                                                              |
| Socket                 | Yes                              | A runner `NWListener` on port 4199 exchanges ping/pong with the host over shared loopback. `TEST_RUNNER_AM_PORT=4199` arrives as `AM_PORT`; `SIMCTL_CHILD_*` was not tested.                                                                                                                                                                  |
| Hierarchy              | Yes                              | `snapshot()` returns frames, labels, identifiers, and element types: 23 probe nodes in a 208×248 pt window and 45 Settings nodes. `debugDescription` also works.                                                                                                                                                                              |
| Tap and press          | Yes                              | Element tap increments the counter 0→1, coordinate tap 1→2, and coordinate `press(forDuration: 1.0)` 2→3.                                                                                                                                                                                                                                     |
| Drag and swipes        | Calls succeed; effect unverified | `press(forDuration:thenDragTo:)` and all four swipe directions return without error; scroll displacement was not read back.                                                                                                                                                                                                                   |
| Home                   | Call succeeds                    | `XCUIDevice.shared.press(.home)` returns without error.                                                                                                                                                                                                                                                                                       |
| Digital Crown rotation | Yes, with Crown focus            | Typed `XCUIDevice` IMP calls change the focused view's bound Crown value. This does not demonstrate scrolling a real `ScrollView`.                                                                                                                                                                                                            |
| Screenshots            | Yes                              | `XCUIScreen.main.screenshot()` produces a 208×248 PNG (9 KB); `simctl io screenshot` also works (7.8 KB).                                                                                                                                                                                                                                     |
| System apps            | Settings yes; Carousel no        | `com.apple.NanoSettings` activates and snapshots 45 nodes in 3.7 s. Launching `com.apple.Carousel` is rejected by `IOSSHLMainWorkspace`.                                                                                                                                                                                                      |
| CtrlProxy typecheck    | Yes, compilation only            | All 238 `Sources/CtrlProxy` files typecheck with the sdk-wire module and ObjC catcher module map for `arm64-apple-watchos10.0-simulator`, with zero errors. Of these, 43 files have `os(iOS)` gates and 34 import UIKit; compiled-out paths do not demonstrate watchOS behaviour. CtrlProxy itself was neither built with xcodebuild nor run. |

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

With about 1 s settling before accessibility-label readback, the bound value
changes as follows. The values are sequential observations, not a delta-to-position
conversion contract.

| Call                                                  | Bound value after call |
| ----------------------------------------------------- | ---------------------- |
| Initial value                                         | 0.00                   |
| By delta 0.5, velocity 1                              | 149.58                 |
| By delta 3.0, velocity 5                              | −443.41                |
| By delta 2.0, no velocity argument                    | 91.92                  |
| `rotateDigitalCrown:velocity:` delta 1.0, velocity 1  | 419.23                 |
| `rotateDigitalCrown:velocity:` delta −1.0, velocity 1 | 91.49                  |

The app binding's sensitivity, step, continuous range, and velocity affect the
result; wrapping/clamping makes the mapping nonlinear. A Crown action must
report the **requested delta**, not a resulting position. Guard each private
selector with `responds(to:)` and return a typed unsupported error if absent.

Each call costs about 5–7 s under the observed load (about 5.3 s between
consecutive 0.1 rotations). Twenty small steps take over 100 s and exceed the
wrapper timeout. Use **one call per Crown action**, with a larger delta as needed
and its own timeout. The enclosing `ScrollView` without a Crown binding does not
move: the first row stays at y=86.5 across all six states.

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
