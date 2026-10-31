# tvOS XCUITest spike

The XCUITest runner approach is viable on the tvOS simulator. The probe uses
Xcode 26.6 (17F113), tvOS 26.5 (23L470), and an Apple TV 4K (3rd generation)
simulator on an arm64 host. Its SwiftUI app contains a 3×3 button grid
(`B00`–`B22`) and a text field. Timings are indicative: host load averages were
120–500.

## Capability boundary

| Check                  | Result                | Evidence and limits                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launch                 | Yes                   | `xcodebuild test-without-building` with `platform=tvOS Simulator` runs the service-style test. App launch takes 2.4–2.7 s; simulator boot 14 s; a trivial warm test invocation 4 s; cold build-for-testing about 7 s with a warm module cache.                                                                                      |
| Socket                 | Yes                   | A runner `NWListener` on port 4189 accepts a host loopback connection and exchanges ping/pong. `TEST_RUNNER_AM_PORT=4189` on the xcodebuild command arrives as `AM_PORT`. `SIMCTL_CHILD_*` was not tested.                                                                                                                          |
| Hierarchy with focus   | Yes                   | `snapshot()` returns frames, labels, identifiers, element types, `hasFocus`, `isEnabled`, and `isSelected`: 17 probe nodes and 98 Settings nodes (`com.apple.TVSettings`, focused `General`). Settings activation plus snapshot takes 3.2–3.8 s.                                                                                    |
| Remote                 | Yes                   | `XCUIRemote.shared.press(_:)` handles up, down, left, right, select, menu, home, and play/pause; `press(.select, forDuration: 1.5)` works. Focus is visible in the next snapshot 8–20 ms after the press returns, at roughly 10 ms polling granularity.                                                                             |
| Direct focus targeting | No                    | `XCUIElement` does not respond to `focus`, `setHasFocus:`, or `requestFocus`. Directional moves reach the geometric neighbour in 9/9 moves from known grid cells, but focus memory changes subsequent destinations.                                                                                                                 |
| Text                   | Yes                   | Selecting the focused field opens the full-screen keyboard: 72 hierarchy elements, with `Keyboard` focused. `app.typeText("hello")` sets the field value to `hello`.                                                                                                                                                                |
| Screenshots            | Yes                   | `XCUIScreen.main.screenshot()` produces a 1920×1080 PNG (5.6 MB); `simctl io screenshot` also works (4.8 MB).                                                                                                                                                                                                                       |
| CtrlProxy typecheck    | Yes, compilation only | All 238 `Sources/CtrlProxy` files typecheck with the sdk-wire module and ObjC catcher module map for `arm64-apple-tvos17.0-simulator`, with zero errors. Of these, 43 files have `os(iOS)` gates and 34 import UIKit; compiled-out iOS paths provide no tvOS behaviour. CtrlProxy itself was neither built with xcodebuild nor run. |

## Focus and runner constraints

Focus targeting requires a path of directional remote moves and a fresh focus
read after every move. The focus engine remembers the last item per column:
moving up from the text field after leaving `B22` returns to `B22`, rather than
the geometrically expected `B21`. A planner cannot infer focus solely from grid
geometry or a previous planned path.

Settings supports system-app hierarchy capture. Activating `com.apple.TVWatchList`
and `com.apple.TVHomeScreen` fails, so those bundle identifiers are not usable
capture targets in this environment. Test invocations sometimes remain running
after a passing test (4/7 runs under load); use a hard timeout and obtain results
from test logs or result files.

The capture at `test/fixtures/tvos-xcuitest/focus-hierarchy.json` preserves the
probe hierarchy with the text field focused at launch. Element types are
`XCUIElement.ElementType` raw values.

## Decision

**GO** for the runner-dependent implementation: hierarchy, focus observation,
remote input, text, sockets, and screenshots are demonstrated. No simulator
device-side questions remain for this spike. Physical Apple TV is out of scope;
tvOS 27 and Duo-style runtimes are untried.
