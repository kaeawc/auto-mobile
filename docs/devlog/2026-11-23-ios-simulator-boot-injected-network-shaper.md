# iOS Simulator network shaping through a boot-injected socket shaper

- Kind: decision
- Date: 2026-11-23
- Source: #19045
- Shaped: [iOS Simulator network shaper](../how-it-works/plat/ios/simulator-network-shaper.md)

## Context

iOS Simulator `networkCondition` used a network-filter system extension. It needs Developer ID
signing and approval in System Settings, or an MDM profile, so headless CI without MDM could not
use it, and it only took one app offline. The auto-mobile-simulator project measured a no-root
alternative: a socket shaper dylib in the simulator's launchd environment.

## Options

- Call the auto-mobile-simulator daemon's `network_shape` method over its socket.
- Ship the shaper source and do the boot injection in AutoMobile.
- Launch injection (`SIMCTL_CHILD_DYLD_INSERT_LIBRARIES` per app launch): covers only the app's
  own sockets, not WebKit's networking extension.
- A shaping proxy set in the device's `configd_sim`: covers only proxy-aware HTTP(S).

## Decision

Ship the shaper source and boot-inject it. `simctl boot` forwards `SIMCTL_CHILD_*` variables into
launchd's environment, so no private CoreSimulator call is needed. The first device-wide degrade
reboots the simulator once; later changes rewrite the profile file. The extension stays the path
for `appId`.

Measured on Xcode 27.2, iOS 27.2 simulator, from a URLSession probe and a Safari page:

| Condition (configured)           | Observed                                                   |
| -------------------------------- | ---------------------------------------------------------- |
| None                             | 100 B request 0.01–0.03 s; 1 MiB 0.01–0.03 s               |
| `delayMs: 300`                   | 100 B request 0.63–0.65 s (two round trips of 300 ms)      |
| `downloadKbps: 1000`             | 1 MiB in 8.43 s (8.39 s expected)                          |
| `3g` (200 ms, 1920 kbps down)    | 100 B 0.50–0.55 s; 1 MiB 4.86 s (4.77 s expected)          |
| 300 ms + 2000 kbps, Safari fetch | 1 MiB 4.88 s (4.79 s expected); 1721 kbps effective        |
| `offline`                        | URLSession -1004 in 0.01–0.26 s; Safari "couldn't connect" |

223 of the 232 processes under the simulator's `launchd_sim` mapped the dylib.

## Consequences

A simulator's first device-wide degrade terminates its running apps. The shaper source and its
resolver stub ship in the npm package, and Xcode must be installed to build the dylib.
