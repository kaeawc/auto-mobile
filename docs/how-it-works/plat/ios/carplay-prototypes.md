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

`ios/carplay-power` reports the screens of a booted simulator. On iOS 26.x, `power-on` writes the
CarPlay settings to `extended_display.plist`, selects TVOut (`screenType == 1`), and calls
`setCurrentMode` with `carPlayProperties` at 800×480. It powers on TVOut and re-enumerates to verify
the same screen reports power state 1 and the requested size. At 1600×960, the CarPlay UI renders
at 1× in a corner of the frame.

Run `power-on` after each boot because CoreSimulator rewrites the plist with `stark` set to 0.
The helper refuses power-on on iOS 27.x with `unsupported-runtime`. The TypeScript bridge uses
`AUTOMOBILE_CARPLAY_POWER_HELPER_PATH`. Its JSON reports screen dimensions and power state, with
`carPlay.found` indicating whether TVOut was present and `carPlay.powerState` null when absent.

## Projection readiness contract

`ios/carplay-projection-probe` targets iOS 17 on arm64 so the same binary runs on iOS 26.x and 27.x
simulators. Run it with `xcrun simctl spawn <udid> <absolute-probe-path>`. Build and ad-hoc sign it with
`bash ios/carplay-projection-probe/build.sh [output-path]`; set
`AUTOMOBILE_CARPLAY_PROJECTION_PROBE_PATH` to the result.

- It enumerates `+[CADisplay displays]` and selects the first display at the highest matching
  priority (Car bit `0x20`, CarInstruments bit `0x40`, device name `wireless0`, AirPlay bit `0x4`).
- It never constructs `FBSDisplayConfiguration`: initializing one for a powered-off, tag-zero
  display can segfault.
- Unavailable selectors fail on stderr with a nonzero exit. No matching display yields
  `found: false` on a successful exit.
- It arms `alarm(10)` on start. The host's 15 s timeout kills `xcrun`, which does not
  necessarily end the process spawned inside the simulator; the alarm bounds it either way.
- `scripts/ios/swift-build.sh` builds it in the macOS Swift CI job when the iphonesimulator SDK is
  27 or later. A unit test checks that both JSON branches in `probe.m` carry exactly the schema's
  keys. Running it needs a booted simulator, so CI does not execute it.

The single JSON line contains `found`, nullable `tag`, `displayId`, `deviceName`, `displayType`,
`identity`, and independent Car and CarInstruments flags. Missing displays have null metadata and
false flags. Identity uses the first matching label in this order, `Car[id]`, `CarInstruments[id]`,
`AirPlay[id]`, `Untagged[id]` (tag zero), then `Tag0x<hex>[id]`.

`captureCarPlayScreen` requires either Car flag before taking a screenshot. A refusal reports the
identity when present, the risk of a black frame, and a recovery action. On iOS 26.x, the CarPlay
display is TVOut (`PurpleTVOut`) and the Wireless screen (`wireless0`) is an unpowered decoy.
`carPlayCaptureDisplay` converts the probed `displayId` to the value for `simctl io screenshot --display`.
`SimCtlClient.screenshot` bounds the capture at 10 s. This capture path is separate from `observe`.

## Background

- [Defer CarPlay prototypes](../../../devlog/2026-11-03-carplay-prototypes-deferred.md)
