# Device-wide camera poster through the launchd environment

- Kind: decision
- Date: 2026-11-23
- Source: #19047
- Shaped: [iOS Simulator camera poster](../how-it-works/plat/ios/simulator-camera-poster.md)

## Context

The camera poster reached only apps that `launchApp` started with
`SIMCTL_CHILD_DYLD_INSERT_LIBRARIES`. Apps started from the home screen, by XCUITest or by the
system had no camera. The issue proposed booting the simulator with the library in its boot
environment, which reaches every process launchd starts, including ExtensionKit processes.

## Options

- Boot environment: `simctl boot` passes `SIMCTL_CHILD_*` variables into the boot environment,
  and CoreSimulator `-[SimDevice bootWithOptions:]` takes an `env` dictionary. Either needs a
  boot, or a reboot of a running simulator, whenever a poster is set, through the boot and
  readiness path.
- `launchctl setenv` in the running simulator: no reboot, and later launches inherit it. The
  issue's research says ExtensionKit processes do not.
- Loading the full poster library into every process: it links UIKit and AVFoundation, which
  every daemon on the simulator would then load.

## Decision

Set the launchd environment with `launchctl setenv` when a poster is set, and insert a gate
library that links only libSystem. The gate loads the poster library only into app processes
that already loaded AVFoundation and have a poster source. The poster itself lives in a
per-simulator config file that the registry mirrors, so later posters and clears need no launchd
change.

On an iOS 27.2 simulator (Xcode 27.2), `startDevice cameraPosterPath` through a private daemon
set the three variables. Two apps then showed the poster with no per-launch environment:
CameraFixture (AVCapturePhotoOutput, preview layer) and a SwiftUI app using
AVCaptureVideoDataOutput (1080x1440 frames). Both were opened by tapping their home-screen
icons. After `setDeviceState cameraPoster clear`, the same tap showed no camera.

## Consequences

- Posters reach apps launched any way, without rebooting the simulator.
- App extensions started through ExtensionKit are not covered. Covering them needs the
  boot-environment path, which can share one boot with other injected libraries because
  `DYLD_INSERT_LIBRARIES` takes a colon-separated list.
- Every process on the simulator loads the gate until the poster is cleared. The gate does
  nothing without a config file, and loads the poster only into user-installed apps.
- Review of #19114 added the undo: every clear path, and the next daemon start, restore the
  launchd environment from a recorded activation. The gate is inserted from a stable copy outside
  the build cache.
- A boot resets launchd's environment, so the poster is re-activated after every boot
  AutoMobile verifies. A boot-time `DYLD_INSERT_LIBRARIES` (`simctl boot` with
  `SIMCTL_CHILD_*`) lives in launchd_sim's own environment: `launchctl getenv` does not show it,
  and launchd keeps it over `launchctl setenv`. Such a simulator reports `deviceWide: false`
  until both libraries can share one boot environment.
