# iOS Simulator network shaper

Device-wide `networkCondition` on an iOS Simulator (no `appId`) runs through a socket shaper that
the simulator boots with. Source: `ios/NetworkShaper/netshape.c`, vendored from the
auto-mobile-simulator `sim-netshape` crate. Background:
[devlog 2026-11-23](../../../devlog/2026-11-23-ios-simulator-boot-injected-network-shaper.md).

## Mechanism

- `IosNetworkShaperDylibProvider` compiles `netshape.c` with the simulator SDK's clang (arm64 and
  x86_64, linked against `libdns_services.tbd`, a stub for the runtime's private resolver
  library), signs it ad hoc and caches it under
  `<data dir>/ios-network-shaper/<hash>-sim-universal/`. The hash covers both files, clang's path
  and the simulator SDK build.
- The Xcode is the caller's `DEVELOPER_DIR`, else, in a repo checkout, the one
  `select_pinned_xcode` in `scripts/ios/xcode_version.sh` picks, else the active Xcode
  (`xcode-select -p`). It is resolved on every `ensure` before the cache is consulted (concurrent
  calls share one probe), and every lookup, compile and sign call gets the injected environment
  with that `DEVELOPER_DIR`.
- `IosSimulatorNetworkShaper.apply` writes the owner file, then the profile to
  `<data dir>/ios-network-shaper/profiles/<UDID>.conf` (temp file plus rename), both before any
  boot, so the first process sees the profile. A failed write or reboot puts back the previous
  profile and owner, or removes them when there were none. Then it checks
  whether the simulator's `launchd_sim` carries the shaper. It reads that process's environment
  with `ps -E` and looks for `DYLD_INSERT_LIBRARIES=<this build>` and
  `SIM_RS_NETSHAPE=<this profile>`.
- When it does not, it runs `simctl shutdown` and then `simctl boot` with
  `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES` and `SIMCTL_CHILD_SIM_RS_NETSHAPE`. It waits with
  `simctl bootstatus` and checks the environment again. simctl passes `SIMCTL_CHILD_*` into launchd's environment, so
  processes in the device load the shaper, including WebKit's networking extension. A boot
  that does not carry it fails the call.
- A new shaper build has a new path, so the next apply reboots once more.
- The injection check and reboot run in a per-UDID `SingleFlight`, so concurrent applies share one
  reboot. The reboot retires the CtrlProxy client first and re-admits it after boot
  (`ctrlProxyClientLifecycle`), as other simulator stops do.

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
- The slot can also hold the session's per-app rule (`iosAppRule`). A device-wide degrade then sets
  `deviceWide` on it, and the restore resets the rule and restores the device, each even when the
  other fails. Resetting only the app rule keeps the device-wide obligation.
- `clear` deletes the profile and owner files and never reboots; the simulator keeps the inert shaper until
  its next plain boot.
- Reads (`getDeviceState`) report the shaper only when a profile file exists and `launchd_sim`
  carries it; otherwise they fall back to the network-extension state. With no profile file they
  run no process scan.
- `apply` writes the daemon's pid to `<UDID>.owner` beside the profile. The restore slot lives in
  session memory, so at startup, after rehydration, the daemon deletes every profile whose owner
  pid is not running (`sweepStaleNetworkShaperProfiles`). That unshapes simulators a crashed or
  stopped daemon left shaped and keeps a live peer's on a shared data dir. The sweep claims a
  profile by renaming it, then re-reads the owner; a changed owner means a live daemon took the
  simulator over, and the profile goes back. Within one daemon, writes, rollbacks, clears and the
  sweep take a per-profile lock.

## Limits

- A few simulator processes do not load the shaper; their traffic is not shaped.
- `localhost` names (RFC 6761) skip the resolver gate, so they resolve while offline.

- TCP exposes no segment arrival times, so HTTP/2 and TLS setup latency is counted more than once.
- Simulators that AutoMobile does not reboot keep running unshaped until the first degrade.
- The per-app `appId` path still uses the network-filter extension.
