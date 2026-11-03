# CarPlay prototypes

Decision record for agent-authored prototypes on CarPlay (#14934, epic #14924).

**Decision: defer.** CarPlay prototypes are not supported. The iOS
[prototype agent](prototype-agent.md) draws only on the phone screen and refuses a `display`
selector, so a spec cannot target the simulator's CarPlay screen. Revisit once the CarPlay
observation work in #14924 is in use.

## Constraint

A CarPlay app mostly cannot draw custom UI. The system renders Apple's templates (`CPListTemplate`,
`CPGridTemplate`, `CPTabBarTemplate`, now playing and so on) out of process; only some categories,
such as the navigation map base view, get a custom window. The prototype agent instead adds a SwiftUI
window inside the target app's process, which CarPlay never shows. Any CarPlay prototype therefore
needs a different rendering path.

## Options considered

| Option                                    | Fidelity                                       | Spec impact                                                                                                  | Constraints                                                                                                                                                                                                        | Test strategy                                                                | Maintenance                                         |
| ----------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------- |
| 1. Mock on the phone screen               | Low: CarPlay-styled look, not the real system  | New template-shaped nodes in the shared vocabulary, across the TS, Kotlin and Swift validators and renderers | None beyond the existing agent                                                                                                                                                                                     | Existing renderer tests at CarPlay screen sizes                              | Three renderers must track Apple's template styling |
| 2. Real templates in a prototype host app | High: real `CPTemplate`s on the CarPlay screen | A template-only spec subset that maps to `CPTemplate` types; most node kinds are refused                     | New host app with a CarPlay scene and a CarPlay entitlement; the simulator's CarPlay window has no headless attach and closed-window captures time out (#14925); local-signing entitlement behaviour is unmeasured | Needs Simulator.app with the CarPlay window open, so no Linux or headless CI | New host, entitlement and signing upkeep per Xcode  |
| 3. Defer                                  | n/a                                            | None                                                                                                         | None                                                                                                                                                                                                               | None                                                                         | None                                                |

## Why defer

- Option 2's prerequisites are open. #14925 found that the CarPlay screen is listed by
  `simctl io enumerate` even with its window closed, that `screenshot`/`recordVideo` with
  `--display=wireless0` time out while it is closed, and that only the Simulator.app menu
  (I/O > External Displays > CarPlay) opens it. Whether a locally signed app with a CarPlay
  entitlement connects in the simulator, and whether XCUITest can see template elements, are not
  yet measured.
- Option 1 grows the shared spec vocabulary in all three renderers for a mock that never exercises
  CarPlay itself, before there is a known user of it.
- #14924's observation work (inventory, screenshots, video, SDK template tree) is the prerequisite
  for verifying either option, and is not yet in use.

## Current behaviour

A spec cannot target CarPlay: `display` is refused on iOS, and the agent's window is only ever on the
phone screen. No CarPlay-specific nodes exist in the spec.

## Revisit when

- #14924's CarPlay observation tools are shipped and used, and
- #14925 has answered the open-window, entitlement and XCUITest questions.

At that point, choose between options 1 and 2 and file implementation issues under a prototype
milestone, not under #14924.
