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

| Option                                    | Fidelity                                       | Spec impact                                                                                                  | Constraints                                                                                                                                                                                                 | Test strategy                                                                | Maintenance                                         |
| ----------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------- |
| 1. Mock on the phone screen               | Low: CarPlay-styled look, not the real system  | New template-shaped nodes in the shared vocabulary, across the TS, Kotlin and Swift validators and renderers | None beyond the existing agent                                                                                                                                                                              | Existing renderer tests at CarPlay screen sizes                              | Three renderers must track Apple's template styling |
| 2. Real templates in a prototype host app | High: real `CPTemplate`s on the CarPlay screen | A template-only spec subset that maps to `CPTemplate` types; most node kinds are refused                     | New host app with a CarPlay scene and a CarPlay entitlement; headless screen power-on uses private CoreSimulator APIs and captures remain black (#17561); local-signing entitlement behaviour is unmeasured | Needs Simulator.app with the CarPlay window open, so no Linux or headless CI | New host, entitlement and signing upkeep per Xcode  |
| 3. Defer                                  | n/a                                            | None                                                                                                         | None                                                                                                                                                                                                        | None                                                                         | None                                                |

## Why defer

- Option 2's prerequisites are open. The CarPlay screen is listed by `simctl io enumerate` while
  powered off. The headless helper can power it on, but captures remain black (#17561). Whether a
  locally signed app with a CarPlay entitlement connects in the simulator, and whether XCUITest can
  see template elements, are not yet measured.
- Option 1 grows the shared spec vocabulary in all three renderers for a mock that never exercises
  CarPlay itself, before there is a known user of it.
- #14924's observation work (inventory, screenshots, video, SDK template tree) is the prerequisite
  for verifying either option, and is not yet in use.

## Current behaviour

A spec cannot target CarPlay: `display` is refused on iOS, and the agent's window is only ever on the
phone screen. No CarPlay-specific nodes exist in the spec. The `ios/carplay-power` helper can report
screens or power on the screen with `screenType == 2` for a booted simulator, optionally enabling
CarPlay first. It checks private CoreSimulator selectors, waits for callbacks, and re-enumerates to
verify power state; unavailable APIs produce actionable errors. The injectable TypeScript bridge
uses `AUTOMOBILE_CARPLAY_POWER_HELPER_PATH`. Its JSON includes screen dimensions and power state;
CarPlay enablement is unknown (`null`) unless this invocation enabled it. Powering the screen does
not resolve black capture frames (#17561) or add observation, interaction, or prototype support.

## Projection readiness contract

`ios/carplay-projection-probe` is an arm64 iOS 27.0 simulator executable, run inside the
selected simulator with `xcrun simctl spawn <udid> <absolute-probe-path>`. Build and ad-hoc sign
it with `bash ios/carplay-projection-probe/build.sh [output-path]`; set
`AUTOMOBILE_CARPLAY_PROJECTION_PROBE_PATH` to the result. It enumerates `+[CADisplay displays]`,
selects `deviceName == "wireless0"`, and reads only `tag`, `displayType` and `displayId` through
typed `objc_msgSend` casts. It never constructs `FBSDisplayConfiguration`: initializing that
configuration for a powered-off, tag-zero display can segfault. Unavailable selectors fail
on stderr with a nonzero exit; absence of wireless0 is a successful `found: false` result.

The single JSON line contains `found`, nullable `tag`, `displayId`, `displayType`, `identity`,
and boolean `isCarDisplay` / `isCarInstrumentsDisplay`. Missing displays have null metadata
and false flags. Car is bit `0x20`; instruments is bit `0x40`. Identity is seed-free, choosing
`Car[id]`, `CarInstruments[id]`, `AirPlay[id]` (bit `0x4`), `Untagged[id]` (tag zero), then
`Tag0x<hex>[id]`, in that priority order. Both Car flags are computed independently.

`carPlayProjection.ts` validates the strict JSON contract over the injectable exec seam with
a 15-second timeout. `requireCarPlayProjection` probes and refuses capture unless either Car
flag is true, reporting the identity, black-frame reason and recovery action. Attachment,
`displayType == 2`, and power-on alone are insufficient: wireless0 can remain AirPlay tagged.
The module is available for future CarPlay capture integration; no `observe` display selector
is wired. A positive tag is a readiness signal, not verification of a captured image.

## Revisit when

- #14924's CarPlay observation tools are shipped and used, and
- #14925 has answered the open-window, entitlement and XCUITest questions.

At that point, choose between options 1 and 2 and file implementation issues under a prototype
milestone, not under #14924.
