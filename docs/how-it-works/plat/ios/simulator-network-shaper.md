# iOS Simulator network shaper

Device-wide `networkCondition` on an iOS Simulator (no `appId`) runs through a socket shaper that
the simulator boots with. Source: `ios/NetworkShaper/netshape.c`, vendored from the
auto-mobile-simulator `sim-netshape` crate. Background:
[devlog 2026-11-23](../../../devlog/2026-11-23-ios-simulator-boot-injected-network-shaper.md).

## Mechanism

- `IosNetworkShaperDylibProvider` compiles `netshape.c` with the simulator SDK's clang (arm64 and
  x86_64, linked against `libdns_services.tbd`, a stub for the runtime's private resolver
  library), signs it ad hoc and caches it under
  `<data dir>/ios-network-shaper/<sha256 of both files>-sim-universal/`.
- `IosSimulatorNetworkShaper.apply` writes the profile to
  `<data dir>/ios-network-shaper/profiles/<UDID>.conf` (temp file plus rename), then checks
  whether the simulator's `launchd_sim` carries the shaper. It reads that process's environment
  with `ps -E` and looks for `DYLD_INSERT_LIBRARIES=<this build>` and
  `SIM_RS_NETSHAPE=<this profile>`.
- When it does not, it runs `simctl shutdown` and then `simctl boot` with
  `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES` and `SIMCTL_CHILD_SIM_RS_NETSHAPE`. It waits with
  `simctl bootstatus` and checks the environment again. simctl passes `SIMCTL_CHILD_*` into launchd's environment, so
  every process in the device loads the shaper, including WebKit's networking extension. A boot
  that does not carry it fails the call.
- A new shaper build has a new path, so the next apply reboots once more.

## The shaper

The dylib interposes `connect`/`connectx`, send and receive calls (including
`sendmsg_x`/`recvmsg_x`), `getaddrinfo` and the resolver result hooks. It shapes only sockets to
non-loopback peers, so CtrlProxy's localhost channel is untouched. It re-reads the profile file at
most every 250 ms, when its modification time changes; a missing file means unshaped.

Profile format (one `key=value` per line; zero means no limit):

```text
offline=0
latency_ms=200
down_kbps=1920
up_kbps=128
loss_pct=2
```

Latency applies to the handshake and to each request/response turnaround. Bandwidth is a token
bucket per direction. `loss_pct` times out that percent of new TCP connections and drops that
percent of UDP datagrams.

## Lifecycle

- A device-wide degrade in a session registers the same `none` restore slot as an Android
  emulator degrade (`shouldRegisterNetworkRestore`). Release, rebind and TTL expiry restore through
  `defaultNetworkConditionRestorer`, which picks the iOS path for a simulator UDID.
- `clear` rewrites the profile as unshaped and never reboots; the simulator keeps the inert shaper
  until its next plain boot.
- Reads (`getDeviceState`) report the shaper only when a profile file exists and `launchd_sim`
  carries it; otherwise they fall back to the network-extension state.

## Limits

- TCP exposes no segment arrival times, so HTTP/2 and TLS setup latency is counted more than once.
- Simulators that AutoMobile does not reboot keep running unshaped until the first degrade.
- The per-app `appId` path still uses the network-filter extension.
