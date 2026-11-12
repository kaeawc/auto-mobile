# tvOS XCUITest spike

The tvOS runner is an XCUITest service-style test on the Apple TV simulator. These are the
runner capabilities and limits it builds on.

## Capability boundary

| Check                  | Result                | Evidence and limits                                                                                                                                                                                                                                                             |
| ---------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Launch                 | Yes                   | `xcodebuild test-without-building` with `platform=tvOS Simulator` runs the service-style test. `TvosRunnerArtifacts` selects an explicit override, local products, or a checksum-verified release archive before building from source.                                          |
| Socket                 | Yes                   | A runner `NWListener` on port 4189 accepts a host loopback connection and exchanges ping/pong. `TEST_RUNNER_AM_PORT=4189` on the xcodebuild command arrives as `AM_PORT`. `SIMCTL_CHILD_*` was not tested.                                                                      |
| Hierarchy with focus   | Yes                   | `snapshot()` returns frames, labels, identifiers, element types, `hasFocus`, `isEnabled`, and `isSelected`, including for `com.apple.TVSettings`.                                                                                                                               |
| Remote                 | Yes                   | `XCUIRemote.shared.press(_:)` handles up, down, left, right, select, menu, home, and play/pause; `press(.select, forDuration: 1.5)` works. Focus is visible in the next snapshot after the press returns.                                                                       |
| Direct focus targeting | No                    | `XCUIElement` does not respond to `focus`, `setHasFocus:`, or `requestFocus`. Directional moves reach the geometric neighbour from known grid cells, but focus memory changes subsequent destinations.                                                                          |
| Text                   | Yes                   | Selecting the focused field opens the full-screen keyboard, with `Keyboard` focused. `app.typeText("hello")` sets the field value to `hello`.                                                                                                                                   |
| Screenshots            | Yes                   | `XCUIScreen.main.screenshot()` and `simctl io screenshot` both work.                                                                                                                                                                                                            |
| CtrlProxy typecheck    | Yes, compilation only | `Sources/CtrlProxy` typechecks with the sdk-wire module and ObjC catcher module map for `arm64-apple-tvos17.0-simulator`. `os(iOS)`-gated and UIKit-importing paths are compiled out and provide no tvOS behaviour. CtrlProxy itself was neither built with xcodebuild nor run. |

## Focus and runner constraints

- Reaching an element takes a path of directional remote moves, with a fresh focus read after
  every move. The focus engine remembers the last item per column (moving up from the text field
  after leaving `B22` returns to `B22`, not the geometric `B21`), so focus cannot be inferred from
  grid geometry or a previously planned path.
- Settings (`com.apple.TVSettings`) supports system-app hierarchy capture. Activating
  `com.apple.TVWatchList` and `com.apple.TVHomeScreen` fails; they are not usable capture targets.
- Under load a test invocation can keep running after the test passes: use a hard timeout and
  read results from test logs or result files.
- `test/fixtures/tvos-xcuitest/focus-hierarchy.json` is the probe hierarchy (text field focused at
  launch). Element types are `XCUIElement.ElementType` raw values.
- Physical Apple TV is out of scope; tvOS 27 and Duo-style runtimes were not covered by the spike.

## Background

- [tvOS XCUITest runner spike](../../../devlog/2026-10-31-xcuitest-spike-tvos-runner.md)
