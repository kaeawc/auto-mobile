# Driverless simulator audio capture

- Kind: decision
- Date: 2026-11-23
- Source: #19046
- Shaped: [iOS Simulator audio loopback](../how-it-works/plat/ios/simulator-audio-loopback.md)

## Context

`captureAudio` read an iOS Simulator's output back from the host's loopback default output
(#13629). That needed a loopback driver such as BlackHole as the Mac's default output, and one
capture heard every simulator on the host. The sim-rs research found that each process inside a
simulator is its own client of the host's `coreaudiod`, so a Core Audio process tap can capture one
device without a driver.

## Options

- Keep the loopback output and isolate simulators by pinning each to its own loopback device through
  `audiosettings.plist` (#13631-#13633). This still needs a driver, and one device pair per simulator.
- Capture through sim-rs's socket API (`audio_capture_start`). This adds a sim-rs dependency to the
  daemon.
- Add a `tap --launchd-pid <pid>` mode to the existing `audio-loopback-helper`, over the same public
  API sim-rs uses.

## Decision

The helper gained `tap`. The daemon finds the simulator's `launchd_sim` PID and taps its
descendants that are Core Audio clients. A helper too old for `tap` reports `usage`, and the daemon
falls back to the loopback output, so a released helper keeps working until the next release.

Measured on Xcode 27.2, iOS 27.2 simulators, macOS host default output = built-in speakers:

- Two simulators playing 1000 Hz and 440 Hz at once: each concurrent tap held its own tone at
  amplitude 0.108, and the other tone stayed below 0.0007.
- A tap delivers frames only while a tapped process plays, so the helper pads silence by the wall
  clock to keep the requested duration.
- With the device pinned to BlackHole, a muted tap made BlackHole silent for exactly the tap's
  2.5 s while the app kept playing, and the tap still captured the tone.
- A 0.3-amplitude tone captured at 0.108 through an unmuted tap, which matches the device's
  `sim_volume` 60 (0.6²). A muted tap captured it at 0.300.
- The helper's System Audio Recording preflight read `undetermined`, yet samples arrived and no
  prompt appeared.

## Consequences

- `captureAudio` and recordings with audio report `route: process-tap` on simulators and need no
  driver. Injection still needs a loopback default input.
- `--mute` is in the helper but not yet on a tool.
- Levels from an unmuted tap follow the simulator's volume, so assertions stay loose.
