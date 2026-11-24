# Read Simulator network activity with host tools

- Kind: decision
- Date: 2026-11-23
- Source: #19020
- Shaped: [iOS Simulator network activity](../how-it-works/plat/ios/simulator-network-activity.md)

## Context

The network filter (#6298, #10263) attributes flows inside a signed `NEFilterDataProvider` system
extension, which needs signing, installation and approval. Observing which simulator process has
which sockets, and how much traffic it moves, needs none of that: simulator processes are host
processes owned by the same user.

## Options

- The network filter extension: already attributes flows, but only where it is installed and
  approved.
- The boot-time socket shaper injected into `launchd_sim` with `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES`
  (#19108): it sees every socket call, but counting there would need a new reporting channel and a
  simulator reboot before the first read.
- Host `ps`, `lsof` and `nettop`: read-only, no reboot, no install.

## Decision

Use host `ps` for the simulator's process tree, `lsof` for sockets and `nettop` for byte counts,
with app attribution by executable path against `simctl listapps`. Exposed as `getDeviceState`
`networkActivity`.

## Consequences

Byte counts cover the sockets open at read time, so a connection that closed earlier is missing
from the totals. Web content traffic shows up under the system `com.apple.WebKit.Networking`
process, which has no `appId`. On the device check, a probe app's held connection showed 2424879
bytes in and 207 out, equal to the server's sent total and the request size.
