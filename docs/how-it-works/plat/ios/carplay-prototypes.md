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

`ios/carplay-power` (`carplay-power-helper <udid> status|power-on`) reports a booted simulator's
screens, or makes its TVOut screen the CarPlay car display. It checks private CoreSimulator
selectors, waits for callbacks, and re-enumerates to verify power state; unavailable APIs produce
actionable errors.

- `power-on` writes a StarkConfig to
  `<device data>/Library/Application Support/Simulator/extended_display.plist` (800x480 @2x,
  `stark` and `hasTouchScreen` true, the other `has*` keys false), then sets TVOut's mode with the
  `HasTouchScreen` and `Stark` CarPlay properties. That powers TVOut on; backboardd makes it the car
  display and CarPlay's home screen renders within about 2 s.
- Both steps are required. CoreSimulator resets the plist to `{"stark":0}` on every boot, so run
  `power-on` after each boot. Running it again on a projecting screen is harmless.
- `power-on` refuses iOS 27 and later runtimes with `unsupported-runtime`: Apple does not support
  CarPlay on that simulator. `status` works on any runtime.
- The TypeScript bridge is injectable and uses `AUTOMOBILE_CARPLAY_POWER_HELPER_PATH`. Its JSON
  lists every screen and a `carPlay` object for TVOut: `found`, nullable `screenID` and
  `powerState`.
- Capture the car display with `xcrun simctl io <udid> screenshot --display=TVOut`. Touch input on
  it is not supported (#18730).

## Projection readiness contract

`ios/carplay-projection-probe` is an arm64 iOS 26.0+ simulator executable, run inside the selected
simulator with `xcrun simctl spawn <udid> <absolute-probe-path>`. Build and ad-hoc sign it with
`bash ios/carplay-projection-probe/build.sh [output-path]`; set
`AUTOMOBILE_CARPLAY_PROJECTION_PROBE_PATH` to the result.

- It enumerates `+[CADisplay displays]` and reports one display, preferred in this order: Car tag,
  CarInstruments tag, AirPlay tag, the display named `TVOut`, the display whose `deviceName` is
  `wireless0`. On iOS 26.x the car display is TVOut (`deviceName` `PurpleTVOut`) and the Wireless
  display's `deviceName` is a UUID.
- It reads `tag`, `displayType` and `displayId` through typed `objc_msgSend` casts, and `name` and
  `deviceName` as strings. It never constructs `FBSDisplayConfiguration`: initializing one for a
  powered-off, tag-zero display can segfault.
- Unavailable selectors fail on stderr with a nonzero exit; no matching display is a successful
  `found: false`.
- It arms `alarm(10)` on start. The host's 15 s timeout kills `xcrun`, which does not
  necessarily end the process spawned inside the simulator; the alarm bounds it either way.
- `scripts/ios/swift-build.sh` builds it in the macOS Swift CI job when the iphonesimulator SDK is
  26 or later. A unit test checks that both JSON branches in `probe.m` carry exactly the schema's
  keys. Running it needs a booted simulator, so CI does not execute it.

Output is one JSON line: `found`, nullable `tag`, `displayId`, `displayType`, `identity`, `name` and
`deviceName`, and boolean `isCarDisplay` / `isCarInstrumentsDisplay`. Missing displays have null
metadata and false flags. Car is bit `0x20`; instruments is bit `0x40`; both flags are computed
independently. Identity is seed-free, chosen in priority order: `Car[id]`, `CarInstruments[id]`,
`AirPlay[id]` (bit `0x4`), `Untagged[id]` (tag zero), then `Tag0x<hex>[id]`. `name` is the value
`simctl io --display` accepts.

`carPlayProjection.ts` validates the strict JSON over the injectable exec seam with a 15 s timeout.
`requireCarPlayProjection` probes and refuses capture unless either Car flag is true. Its error
names the screen and identity, explains the black frame and gives the recovery step. Attachment and power-on alone are not
enough: TVOut stays untagged without the StarkConfig. A positive tag is a readiness signal, not
verification of a captured image. `captureCarPlayScreen` runs that check before taking a
screenshot and passes the probed `displayId` (`carPlayCaptureDisplay`) as `simctl io screenshot
--display`, so a refused or unpowered screen is never captured. No `observe` display selector uses
it yet.

## Background

- [Defer CarPlay prototypes](../../../devlog/2026-11-03-carplay-prototypes-deferred.md)
- [Headless CarPlay on TVOut with a StarkConfig](../../../devlog/2026-11-19-headless-carplay-tvout-stark.md)
