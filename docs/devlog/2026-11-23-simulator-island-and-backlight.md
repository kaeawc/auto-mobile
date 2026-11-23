# Simulator Dynamic Island and backlight through defaults and JXA

- Kind: decision
- Date: 2026-11-23
- Source: issue #19018
- Shaped: [iOS Simulator Dynamic Island and backlight](../how-it-works/plat/ios/simulator-island-and-backlight.md)

## Context

Issue #19018 asked for two CoreSimulator controls simctl does not expose,
`-[SimDevice setDynamicIslandSuppressed:error:]` and `-[SimDevice setDisplayBacklightActive:error:]`,
as `displayConfig` options restored on reset. Both returned success on an iPhone 17 Pro
simulator (Xcode 27.2, iOS 27.2). A simulator log stream showed CoreSimulatorBridge writing
`SBSuppressDynamicIslandCompletely` in `com.apple.springboard` for the first call and SpringBoard
taking a SystemAperture suppression assertion. A plain `defaults write` of the same key did the
same. The second call drove SpringBoard's backlight state machine (`ActiveOn->InactiveOn`), read
back through `com.apple.springboard.hasBlankedScreen`.

## Options

- Load CoreSimulator into the daemon with Bun FFI and `objc_msgSend`.
- A Swift helper like `ios/carplay-power`, built separately and found through an environment
  variable.
- A short `osascript -l JavaScript` run per call.
- For the island only: `simctl spawn defaults` on the key the private call writes.

## Decision

The island uses `simctl spawn defaults`, which is readable, persists like the private call and
needs no private framework. The backlight uses JXA: no build step or environment variable, about
0.2 s per call, and the private framework never loads into the long-lived daemon.

## Consequences

The island control depends on SpringBoard keeping that default name, and the backlight on the
selector name and `SimServiceContext`. A rename makes the island write a no-op and the backlight
call fail with a CoreSimulator error. The backlight call loads the host's shared
CoreSimulator, so it works under any installed Xcode.

The JXA call passes null for the NSError out-parameter. On that simulator, shut down, passing a
`Ref()` made the failed backlight call crash osascript with SIGSEGV (exit 139); null returned NO
cleanly. The script therefore checks that the device is booted and reports error codes as JSON.
