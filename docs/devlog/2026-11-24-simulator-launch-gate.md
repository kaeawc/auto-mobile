# Launch-time libraries load through a gate on a shaped simulator

- Kind: decision
- Date: 2026-11-24
- Source: #19165, #19119 item 5
- Shaped: [iOS Simulator camera poster](../how-it-works/plat/ios/simulator-camera-poster.md)

## Context

The network shaper boots the simulator with `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES` (#19108).
launchd_sim then gives every process that boot-time value. It wins over the
`DYLD_INSERT_LIBRARIES` a `simctl launch` passes, even when the launch value lists the shaper
first, and over `launchctl setenv` and `unsetenv`. Other launch variables still reach the app. So
`launchApp prototype: true` could not load the agent, and the camera poster could not turn on
device-wide, until the simulator was rebooted without the shaper.

## Options

- Merge the boot value into the launch value. Measured on iOS 27.2: the app still gets only the
  boot value.
- Boot the simulator with every library. The prototype agent links UIKit and would load into
  every daemon.
- Fail `launchApp prototype: true` with a reboot hint when the shaper is injected.
- Boot with the camera poster's gate after the shaper, and have the gate load the libraries a
  launch names in `AM_INSERT_LIBRARIES`.

## Decision

The last option. The gate links only libSystem, loads launch libraries only into user-installed
apps, and is inert without them or a poster. Every launch that inserts a library names it in
both lists. When the boot value holds the gate, device-wide poster activation sets only the poster
variables. A shaped reboot notifies the boot hooks so a recorded poster is applied again.

## Consequences

The shaper, the camera poster and the prototype agent load into the same app on a shaped
simulator. A simulator shaped by an earlier build lacks the gate, so the next apply reboots it
once. Setting the profile to `none` keeps the shaper and the gate, and injection keeps working.
