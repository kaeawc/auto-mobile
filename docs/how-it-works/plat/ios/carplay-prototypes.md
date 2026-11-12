# CarPlay prototypes

CarPlay prototypes are not supported (#14934, epic #14924). The iOS
[prototype agent](prototype-agent.md) draws only on the phone screen: it adds a SwiftUI window
inside the target app's process, which CarPlay never shows, and it refuses a `display` selector. No
CarPlay-specific nodes exist in the spec.

A CarPlay app mostly cannot draw custom UI. The system renders Apple's templates (`CPListTemplate`,
`CPGridTemplate`, `CPTabBarTemplate`, now playing and so on) out of process; only some categories,
such as the navigation map base view, get a custom window. Any CarPlay prototype needs a different
rendering path.

## CarPlay screen power helper

`ios/carplay-power` reports screens, or powers on the screen with `screenType == 2` for a booted
simulator, optionally enabling CarPlay first. It checks private CoreSimulator selectors, waits for
callbacks, and re-enumerates to verify power state; unavailable APIs produce actionable errors.

- The TypeScript bridge is injectable and uses `AUTOMOBILE_CARPLAY_POWER_HELPER_PATH`.
- Its JSON includes screen dimensions and power state. CarPlay enablement is `null` (unknown) unless
  this invocation enabled it.
- The CarPlay screen is listed by `simctl io enumerate` even while powered off. Powering it on does
  not fix black capture frames (#17561) and adds no observation, interaction or prototype support.

## Projection readiness contract

`ios/carplay-projection-probe` is an arm64 iOS 27.0 simulator executable, run inside the selected
simulator with `xcrun simctl spawn <udid> <absolute-probe-path>`. Build and ad-hoc sign it with
`bash ios/carplay-projection-probe/build.sh [output-path]`; set
`AUTOMOBILE_CARPLAY_PROJECTION_PROBE_PATH` to the result.

- It enumerates `+[CADisplay displays]`, selects `deviceName == "wireless0"`, and reads only `tag`,
  `displayType` and `displayId` through typed `objc_msgSend` casts.
- It never constructs `FBSDisplayConfiguration`: initializing one for a powered-off, tag-zero
  display can segfault.
- Unavailable selectors fail on stderr with a nonzero exit; no wireless0 is a successful
  `found: false`.

Output is one JSON line: `found`, nullable `tag`, `displayId`, `displayType`, `identity`, and
boolean `isCarDisplay` / `isCarInstrumentsDisplay`. Missing displays have null metadata and false
flags. Car is bit `0x20`; instruments is bit `0x40`; both flags are computed independently. Identity
is seed-free, chosen in priority order: `Car[id]`, `CarInstruments[id]`, `AirPlay[id]` (bit `0x4`),
`Untagged[id]` (tag zero), then `Tag0x<hex>[id]`.

`carPlayProjection.ts` validates the strict JSON over the injectable exec seam with a 15 s timeout.
`requireCarPlayProjection` probes and refuses capture unless either Car flag is true, reporting the
identity, black-frame reason and recovery action. Attachment, `displayType == 2` and power-on alone
are not enough: wireless0 can stay AirPlay-tagged. A positive tag is a readiness signal, not
verification of a captured image. No `observe` display selector uses this module yet.

## Background

- [Defer CarPlay prototypes](../../../devlog/2026-11-03-carplay-prototypes-deferred.md)
