# Reach Simulator render overlays through osascript

- Kind: decision
- Date: 2026-11-23
- Source: #19016
- Shaped: [iOS Simulator render overlays](../how-it-works/plat/ios/simulator-render-overlays.md)

## Context

Simulator.app's Debug menu turns on Core Animation overlays (blended layers, off-screen rendering,
misaligned images). `simctl` has no subcommand for them. The issue found the private
`-[SimDevice setCADebugOption:enabled:]` and `getCADebugOption:` and mapped option ids by
screenshot diffs.

## Options

- Load CoreSimulator into the daemon with `bun:ffi` and `objc_msgSend`. The daemon already uses
  `bun:ffi` for small C calls, but a private Objective-C framework in the daemon process means a
  crash or Xcode mismatch takes the daemon down.
- A signed Swift helper, like the audio-loopback and CarPlay helpers. It needs a build, a release
  asset and a checksum pin for two method calls.
- A JavaScript for Automation script run by `/usr/bin/osascript`. The ObjC bridge can load the
  framework and call both methods, needs no build or signing, and runs in its own process.

## Decision

Run a JavaScript for Automation script through `osascript` for every read and write.

## Consequences

Each call costs one `osascript` process, 250 to 600 ms on a loaded host. A failure stays in that process and reaches
the caller as an `ActionableError`. A CoreSimulator release that renames the selectors breaks the
script, which reports the missing selector by name.
