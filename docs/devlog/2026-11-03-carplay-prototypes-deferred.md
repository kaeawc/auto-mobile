# Defer CarPlay prototypes

- Kind: decision
- Date: 2026-11-03
- Source: moved from `how-it-works/plat/ios/carplay-prototypes.md`; #14934, #14924, #14925, #17561,
  #16557
- Shaped: [CarPlay prototypes](../how-it-works/plat/ios/carplay-prototypes.md)

## Context

The prototype agent draws a SwiftUI window inside the target app's process, which CarPlay never
shows; CarPlay renders Apple's templates out of process. Any CarPlay prototype needs a different
rendering path.

## Options

| Option                                    | Fidelity                                       | Spec impact                                                                                                  | Constraints                                                                                                                                                                                                 | Test strategy                                                                | Maintenance                                         |
| ----------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------- |
| 1. Mock on the phone screen               | Low: CarPlay-styled look, not the real system  | New template-shaped nodes in the shared vocabulary, across the TS, Kotlin and Swift validators and renderers | None beyond the existing agent                                                                                                                                                                              | Existing renderer tests at CarPlay screen sizes                              | Three renderers must track Apple's template styling |
| 2. Real templates in a prototype host app | High: real `CPTemplate`s on the CarPlay screen | A template-only spec subset that maps to `CPTemplate` types; most node kinds are refused                     | New host app with a CarPlay scene and a CarPlay entitlement; headless screen power-on uses private CoreSimulator APIs and captures remain black (#17561); local-signing entitlement behaviour is unmeasured | Needs Simulator.app with the CarPlay window open, so no Linux or headless CI | New host, entitlement and signing upkeep per Xcode  |
| 3. Defer                                  | n/a                                            | None                                                                                                         | None                                                                                                                                                                                                        | None                                                                         | None                                                |

## Decision

Defer (option 3).

- Option 2's prerequisites are open: the headless helper can power the CarPlay screen on, but
  captures stay black (#17561). Whether a locally signed app with a CarPlay entitlement connects in
  the simulator, and whether XCUITest can see template elements, were not measured.
- Option 1 grows the shared spec vocabulary in all three renderers for a mock that never exercises
  CarPlay itself, before there is a known user.
- #14924's observation work (inventory, screenshots, video, SDK template tree) is the prerequisite
  for verifying either option, and was not yet in use.

## Consequences

A spec cannot target CarPlay. Revisit when #14924's CarPlay observation tools are shipped and used
and #14925 has answered the open-window, entitlement and XCUITest questions. Then choose between
options 1 and 2 and file implementation issues under a prototype milestone, not under #14924.
