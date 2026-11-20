# Headless CarPlay on TVOut with a StarkConfig

- Kind: decision
- Date: 2026-11-19
- Source: #18714, #18727, #18728
- Shaped: [CarPlay prototypes](../how-it-works/plat/ios/carplay-prototypes.md)

## Context

The CarPlay screen captured black on the iOS 27.0 runtime, and its DashBoard crashed calling a
`CARSession` method the simulator's CarKit lacks (#17544, #17561). The power helper powered the
Wireless screen and enabled CarPlay, and the projection probe looked only at `wireless0`. Apple's
Xcode 27.3 release notes list "iOS Simulator is not supported for CarPlay" (179494052) as a known
issue.

## Options

- Power the Wireless screen and call `enableCarPlay:`, as before.
- Reproduce Simulator.app's own sequence headlessly: a StarkConfig plist plus a TVOut mode change
  with CarPlay properties.
- Inject the missing `CARSession` methods on iOS 27.
- Use the SDK template tree only, with no pixels.

## Decision

On iOS 26.x runtimes, write `extended_display.plist` (800x480 @2x, `stark` and `hasTouchScreen`
true) into the device's data directory, then call
`setCurrentMode:pixelSize:carPlayProperties:` on TVOut with `HasTouchScreen` and `Stark`. The spike
on a fresh iOS 26.5 iPhone simulator rendered the CarPlay home screen (99.9% non-black) within
about 2 s. Each half alone left a black frame, and `enableCarPlay:`, the Stark HID service and the
Wireless screen were not needed. Power-on refuses iOS 27 runtimes. The probe selects the car
display by tag, not by name.

## Consequences

- The helper must run after every boot: CoreSimulator resets the plist to `{"stark":0}`.
- Pixels work only while Xcode 26.x simulators are available; the SDK template tree remains the
  long-term path.
- Touch on the car display is unsolved: a HID tap at the TVOut target aborted backboardd (#18730).
