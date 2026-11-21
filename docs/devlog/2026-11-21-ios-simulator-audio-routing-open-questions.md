# iOS Simulator audio routing open questions

- Kind: concept
- Date: 2026-11-21
- Source: #18678, #18836, moved from [iOS Simulator audio isolation](../how-it-works/plat/ios/simulator-audio-isolation.md)
- Shaped: [iOS Simulator audio isolation](../how-it-works/plat/ios/simulator-audio-isolation.md)

## Context

The per-simulator pinning spike (#13631) measured two private routing interfaces on different hosts
and runtimes. Some results disagree and some behavior was not measured. The
[decision record](2026-11-19-ios-simulator-audio-isolation.md) makes per-simulator pinning wait on
measurements; these are the open ones.

## Open questions

- Pin persistence: `SimDeviceAudioClient` (Xcode 26.6, iOS 27.0) kept a pin visible to a later
  process, while `SimAudioHostRoutable` (CoreSimulator 1174.9.2, iOS 26.5) did not. Settling it
  needs both interfaces run against the same simulator on one host and runtime, read back from a
  second process and again after a reboot.
- Device scope: a combined input+output virtual device (BlackHole 2ch, scope 3) is dropped for
  every route. That the router accepts only a device whose scope equals the requested scope is a
  hypothesis; confirming it needs an input-only or output-only virtual device.
- Two simulators pinned to two different non-default devices: needs a second host input or a
  single-scope virtual device.
- Whether a pin survives a `coreaudiod` restart: needs sudo and interrupts every booted simulator.
- Whether the guest hears the pinned device: needs an in-simulator audio client.
