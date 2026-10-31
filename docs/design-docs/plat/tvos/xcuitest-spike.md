# tvOS XCUITest spike

The XCUITest runner approach is viable on the tvOS simulator, as demonstrated
with Xcode 26.6, tvOS 26.5, and an Apple TV 4K (3rd generation) simulator. The
probe app is a SwiftUI app with a 3×3 button grid and a text field.

## Capability boundary

| Check                  | Result                | Evidence and limits                                                                                                                                                                                                                                                             |
| ---------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launch                 | Yes                   | `xcodebuild test-without-building` with `platform=tvOS Simulator` runs the service-style test.                                                                                                                                                                                  |
| Socket                 | Yes                   | A runner `NWListener` on port 4189 accepts a host loopback connection and exchanges ping/pong. `TEST_RUNNER_AM_PORT=4189` on the xcodebuild command arrives as `AM_PORT`. `SIMCTL_CHILD_*` was not tested.                                                                      |
| Hierarchy with focus   | Yes                   | `snapshot()` returns frames, labels, identifiers, element types, `hasFocus`, `isEnabled`, and `isSelected`, including for `com.apple.TVSettings`.                                                                                                                               |
| Remote                 | Yes                   | `XCUIRemote.shared.press(_:)` handles up, down, left, right, select, menu, home, and play/pause; `press(.select, forDuration: 1.5)` works. Focus is visible in the next snapshot after the press returns.                                                                       |
| Direct focus targeting | No                    | `XCUIElement` does not respond to `focus`, `setHasFocus:`, or `requestFocus`. Directional moves reach the geometric neighbour from known grid cells, but focus memory changes subsequent destinations.                                                                          |
| Text                   | Yes                   | Selecting the focused field opens the full-screen keyboard, with `Keyboard` focused. `app.typeText("hello")` sets the field value to `hello`.                                                                                                                                   |
| Screenshots            | Yes                   | `XCUIScreen.main.screenshot()` and `simctl io screenshot` both work.                                                                                                                                                                                                            |
| CtrlProxy typecheck    | Yes, compilation only | `Sources/CtrlProxy` typechecks with the sdk-wire module and ObjC catcher module map for `arm64-apple-tvos17.0-simulator`. `os(iOS)`-gated and UIKit-importing paths are compiled out and provide no tvOS behaviour. CtrlProxy itself was neither built with xcodebuild nor run. |

## Focus and runner constraints

Focus targeting requires a path of directional remote moves and a fresh focus
read after every move. The focus engine remembers the last item per column:
moving up from the text field after leaving `B22` returns to `B22`, rather than
the geometrically expected `B21`. A planner cannot infer focus solely from grid
geometry or a previous planned path.

Settings supports system-app hierarchy capture. Activating `com.apple.TVWatchList`
and `com.apple.TVHomeScreen` fails, so those bundle identifiers are not usable
capture targets in this environment. Test invocations can remain running
after a passing test under load; use a hard timeout and obtain results
from test logs or result files.

The capture at `test/fixtures/tvos-xcuitest/focus-hierarchy.json` preserves the
probe hierarchy with the text field focused at launch. Element types are
`XCUIElement.ElementType` raw values.

## Decision

**GO** for the runner-dependent implementation: hierarchy, focus observation,
remote input, text, sockets, and screenshots are demonstrated. No simulator
device-side questions remain for this spike. Physical Apple TV is out of scope;
tvOS 27 and Duo-style runtimes are untried.
