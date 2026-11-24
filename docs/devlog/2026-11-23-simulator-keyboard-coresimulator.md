# Keyboard control through CoreSimulator

- Kind: decision
- Date: 2026-11-23
- Source: #19017
- Shaped: [iOS Simulator keyboard](../how-it-works/plat/ios/simulator-keyboard.md)

## Context

Keyboard behavior differs when a simulator's hardware keyboard is connected (#14953), and tests
depended on whatever state the simulator was left in. `simctl` cannot connect or disconnect the
hardware keyboard or set the keyboard language. CoreSimulator's `SimDevice` has
`setHardwareKeyboardEnabled:keyboardType:error:` and `setKeyboardLanguage:error:`.

## Options

- A Swift helper executable like `ios/carplay-power`, which a user builds and points an
  environment variable at.
- `bun:ffi` calls into libobjc and CoreSimulator inside the daemon.
- A JXA script run by `osascript`, which ships with macOS.

## Decision

Run the calls in JXA through `osascript`. It needs no build or release artifact, and an
unsupported identifier or a private-API change cannot crash the daemon: a JXA run that boxed the
NSError out-parameter crashed with SIGSEGV during testing. Expose them as `setDeviceState keyboard`,
journal each change, and restore it on keep-booted reset.

## Consequences

The hardware keyboard has no read-back, so its restore target is the boot state (connected, ANSI),
not a state a person set in Simulator.app or Device Hub. A language change also appends to
`AppleLanguages`, which can change an app's localization fallback until the session resets.
