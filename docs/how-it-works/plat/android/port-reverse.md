# Android port reverse ownership

`portReverse` (`src/server/portReverseTools.ts`) lets a client own `adb reverse`
mappings for its session. `PortReverseManager`
(`src/features/portReverse/PortReverseManager.ts`) holds the state; the adb
commands and the `adb reverse --list` parser live in one place,
`src/utils/android-cmdline-tools/adbReverse.ts`.

## Ownership

- One owner per device port: the routed session UUID, or `sessionless`. State is
  per device serial, and the manager serialises operations on one device. The
  tool and the daemon's session cleanup share one process-wide manager.
- On `ensure`, a mapping AutoMobile did not create for this session is a
  `port_reverse_conflict`, and `ensure` never overwrites it. That covers another
  session's, a user's or a prototype's mapping, and one of AutoMobile's own that
  something outside AutoMobile re-pointed. It judges conflicts on the device as
  listed, before any restore, so a refused request changes nothing. It adds with
  `--no-rebind`; if `--list` then shows the port of a refused add, it reports a
  conflict. A later failed add rolls back this call's earlier adds through the
  same re-checked removal.
- A conflict gets one kind per port: `other_session` (owned by another live
  session) or `prototype` (held by a prototype, to another host port). An
  unowned port is `external_live` when a host loopback connect to its `tcp:`
  target succeeds, otherwise `external_unknown`. The owned map is in memory, so
  after a daemon restart every surviving mapping is external. A clash with the
  caller's own mapping has no kind.
- `ensure {reclaimStale: true}` replaces an unowned mapping only when the call is
  session-routed (the session holds the device), the host spec is `tcp:H`, and
  `HostLoopbackProbe` finds both 127.0.0.1:H and [::1]:H absent. The adb server
  tries IPv4 then IPv6, so either accepting means live. A timeout or unexpected
  error is unknown and never reclaims. It re-reads `--list` right before
  `--remove` and leaves a port that changed meanwhile (`port_reverse_reclaim_failed`,
  after rolling back this call's adds). Otherwise it audit-logs the reclaim and
  adds the requested mapping with `--no-rebind`. The adb server connects the
  `tcp:H` target, so `ensure` uses the probe only when that server is on this
  host's loopback (`adbServerScope` is `tcp-localhost-*`). With a remote or
  non-TCP server every check is unknown: nothing is reclaimed and the result
  omits `hostListening`. A reclaimed mapping is not restored if a later add in
  the call fails: its host target was dead.
- `remove` refuses ports the session does not own, then re-reads `--list` and
  removes a port only while it still maps to the host port AutoMobile set. The
  `adb reverse --remove` command takes no host argument, so AutoMobile cannot
  detect a re-point between that read and the removal. The manager drops
  ownership only once removal succeeds or the mapping is gone or re-pointed. It
  never uses `--remove-all`.
- The manager registers with an ownership view (`AdbReverseOwnership`) built for
  sharing ports with another manager (#17253). It runs every operation on a
  device through its per-device queue (`exclusive`), so a `--list`, the
  ownership decision on it and the add or removal that follows never
  interleave. A task must never wait for another task on the same device. No
  other manager registers: prototypes make no `adb reverse`, so the manager
  never reports a prototype hold, the `prototype` conflict or
  `owner: "prototype"`. The view is in memory and per process.

## Device listeners

`list` and `verify` read `/proc/net/tcp` and `/proc/net/tcp6` in one shell call,
each file after a marker line, so a missing file is just an unreadable section.
They keep LISTEN rows whose local address is wildcard or loopback (`0.0.0.0`,
`127/8`, `::`, `::1`, `::ffff:127/8`): the sockets that stop adbd binding the
reverse. A listened port that `--list` shows is `reverse`; any other is
`process` with the row's uid, and `pm list packages -U` names the package only
when exactly one has that uid. No readable table is `unsupported`; there is no
`netstat` fallback. When an `ensure` add fails and `--list` shows no
reverse there, `ensure` reads the table again. A `process` holder turns the failure
into `port_reverse_device_port_in_use`; anything else keeps the adb error.

## Verify probes

`verify {probe: true}` runs one bounded `timeout nc` connect per port on the
device and reads its exit status (`portProbeScript`). An HTTP probe
(`probe: {http}`) runs `portHttpProbeScript`. Its request lines are `printf`
arguments, never its format, so the path goes out verbatim. The path and `Host`
header must be printable ASCII without spaces (`PROBE_PATH_PATTERN`,
`PROBE_HOST_HEADER_PATTERN`), so no header can be injected. It sends HTTP/1.0
with `Connection: close` and prints the same exit marker as the TCP probe, so a
refused connect or a missing binary reads the same way. A status line at the
start of the output is a response whatever the exit status; anything else
without `Connection refused` is `no_http_response`, except silence until the
device timeout (`timeout`). Both probes retry once on an empty close (the first
connect after a host restart can race) and are bounded host-side by a
`raceWithDeadline` on the injected timer.

## Restore

Reverse listeners live in adbd, so an adb server restart, `adb reconnect`, an
adbd restart (`root`/`unroot`) or an emulator restart drops them. Every
`portReverse` call except `remove` re-reads `--list` and re-adds the device's
owned mappings that are missing, reporting the caller's in `restored` or
`restoreFailures`. A failed restore keeps ownership so the next call retries.
The manager drops a port someone else re-mapped while ours was gone from
ownership and leaves it in place.

The `reconcile(deviceId)` method runs the same pass without a client call. The
transport-recovery scheduler calls it after a device's adb transport recovers.
A periodic reconcile calls it for mappings removed while the transport stayed up
(a raw `adb reverse --remove`, another tool). Each `ensure` that leaves owned
mappings arms the periodic timer (injected `Timer`,
`AUTOMOBILE_PORT_REVERSE_RECONCILE_INTERVAL_MS`, default 30 s). Once no device
holds any, nothing re-arms it. A pass reconciles at most four devices, one
at a time, rotating through the rest on later passes; an unreachable device is
logged at debug and retried on a later pass. Disposal cancels the timer and
waits for a running pass.

## Release

Session release and device unbind remove that session's mappings on the device.
They register as pending device cleanup, so the next session waits for it.
Ownership is recorded only after `adb reverse` succeeds. A session with an
`ensure` still queued or running on the device therefore also counts as owning
mappings there. Its removal queues behind that `ensure` on the device's serial
operation chain and removes whatever it added.

Device removal from the pool forgets `sessionless` ownership without sending a
command. The event cannot tell a disconnect or relaunch (whose reverses died
with the transport) from identity replacement (another device on the serial,
whose mappings are not ours). It leaves session-owned mappings alone: Android
recovery removes and re-adds a device while its session stays bound, and that
session's next call restores its mappings.

A released mapping whose removal fails (or whose device cannot answer `--list`)
leaves `owned`, so it is never restored. It waits in a pending-removal set. The
device's next `--list` retries the removal while the port still maps to the host
port AutoMobile set, and drops it once the port is gone or re-pointed. When
release reports that another device now answers on the serial (identity
replacement), the manager forgets the session's ownership and the device's
pending removals without sending any command.

## Policy

Device and host ports must be 1024-65535 and, when
`AUTOMOBILE_PORT_REVERSE_ALLOWED_PORTS` is set, inside its ranges. An invalid
value allows nothing. The host side is always `tcp:<port>` on loopback. Ensure,
remove and restore are audit-logged at info with device and session.
