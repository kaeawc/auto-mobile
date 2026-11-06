# Android port reverse ownership

`portReverse` (`src/server/portReverseTools.ts`) lets a client own `adb reverse`
mappings for its session. `PortReverseManager`
(`src/features/portReverse/PortReverseManager.ts`) holds the state; the adb
commands and the `adb reverse --list` parser live in one place,
`src/utils/android-cmdline-tools/adbReverse.ts`, which the prototype reverse
manager (#12530) also uses.

## Ownership

- One owner per device port: the routed session UUID, or `sessionless`. State is
  per device serial; operations on one device are serialised. One process-wide
  manager is shared by the tool and the daemon's session cleanup.
- A mapping AutoMobile did not create for this session (another session's, a
  user's, a prototype's), or one of its own that was re-pointed outside
  AutoMobile, is a `port_reverse_conflict` on `ensure`, never overwritten.
  `ensure` judges conflicts on the device as listed, before any restore, so a
  refused request changes nothing. It adds with `--no-rebind`; a refused add
  whose port `--list` then shows is reported as a conflict. A later failed add
  rolls back this call's earlier adds through the same re-checked removal.
- A conflict is classified per port as `other_session` (owned by another live
  session), `prototype` (held by a prototype, to another host port),
  `external_live` (unowned and a host loopback connect to its `tcp:` target
  succeeds) or `external_unknown` (anything else unowned). The owned map
  is in memory, so after a daemon restart every surviving mapping is external.
  A clash with the caller's own mapping has no kind.
- `ensure {reclaimStale: true}` replaces an unowned mapping only when the call is
  session-routed (the session holds the device), the host spec is `tcp:H`, and
  `HostLoopbackProbe` finds both 127.0.0.1:H and [::1]:H absent (the adb server
  tries IPv4 then IPv6, so either accepting means live; a timeout or unexpected
  error is unknown and never reclaims). It re-reads `--list` just before
  `--remove` and leaves a port that changed meanwhile (`port_reverse_reclaim_failed`,
  after rolling back this call's adds), then audit-logs the reclaim and adds the
  requested mapping with `--no-rebind`. The adb server connects the `tcp:H`
  target, so the probe is used only when that server is on this host's loopback
  (`adbServerScope` is `tcp-localhost-*`); with a remote or non-TCP server every
  check is unknown, nothing is reclaimed and `hostListening` is omitted. A
  reclaimed mapping is not restored if a later add in the same call fails: its
  host target was dead.
- `remove` refuses ports the session does not own, then re-reads `--list` and
  removes a port only while it still maps to the host port AutoMobile set.
  `adb reverse --remove` takes no host argument, so a re-point between that read
  and the removal cannot be detected. Ownership is dropped only once removal
  succeeds or the mapping is gone or re-pointed. `--remove-all` is never used.
- The prototype manager and this one keep separate owner maps but share one
  ownership view (`AdbReverseOwnership`), where each answers from its own state
  whether it holds a device port and to which host port (#17253). A prototype
  joins a session's port only when `--list` shows it still mapped to the
  session's host port; a lost one is added, a re-pointed one left alone, and
  one re-pointed after the join is re-checked with `--list` and left in place
  when the prototype releases it.
  `ensure` on a prototype-held port to the same host port joins it (status
  `present`) while it still maps where the prototype set it, and to another
  host port is a `prototype` conflict; a re-pointed one is external. A failed
  `ensure` gives its joined ports back with its adds. Neither manager removes a
  port the other still holds at the same host port: `remove` of a shared port drops the session's
  ownership and reports `released` with `owner: "prototype"`, and the last
  holder removes the mapping. Both managers run every operation on a device
  through the view's one per-device queue (`exclusive`), so a `--list`, the
  ownership decision on it and the add or removal that follows never interleave
  with the other manager's work on that device; a prototype show therefore waits
  behind a session's in-flight call on the same device, probes included. A task
  must never wait for another task on the same device. A session's pending removal
  counts as a hold, and is dropped without removing when a prototype holds the
  port. The view is in memory and per process.

## Device listeners

`list` and `verify` read `/proc/net/tcp` and `/proc/net/tcp6` in one shell call
(each file after a marker line, so a missing file is just an unreadable section)
and keep LISTEN rows whose local address is wildcard or loopback (`0.0.0.0`,
`127/8`, `::`, `::1`, `::ffff:127/8`), the sockets that stop adbd binding the
reverse. A listened port that `--list` shows is `reverse`; any other is
`process` with the row's uid, and `pm list packages -U` names the package only
when exactly one has that uid. No readable table is `unsupported`; there is no
`netstat` fallback yet. When an `ensure` add fails and `--list` shows no
reverse there, the table is read again and a `process` holder turns the failure
into `port_reverse_device_port_in_use`; anything else keeps the adb error.

## Verify probes

`verify {probe: true}` runs one bounded `timeout nc` connect per port on the
device and reads its exit status (`portProbeScript`). `probe: {http}` runs
`portHttpProbeScript`: the request lines are `printf` arguments, never its
format, so the path is sent verbatim, and the path and `Host` header are
restricted to printable ASCII without spaces (`PROBE_PATH_PATTERN`,
`PROBE_HOST_HEADER_PATTERN`) so no header can be injected. It sends HTTP/1.0
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
`restoreFailures`. A failed restore keeps ownership so the next call retries. A
port someone else re-mapped while ours was gone is dropped from ownership and
left in place. `reconcile(deviceId)` runs the same pass without a client call:
the transport-recovery scheduler calls it after a device's adb transport
recovers, and a periodic reconcile calls it for mappings removed while the
transport stayed up (a raw `adb reverse --remove`, another tool). The periodic
timer (injected `Timer`, `AUTOMOBILE_PORT_REVERSE_RECONCILE_INTERVAL_MS`,
default 30 s) is armed by each `ensure` that leaves owned mappings and not
re-armed once no device holds any. A pass reconciles at most four devices, one
at a time, rotating through the rest on later passes; an unreachable device is
logged at debug and retried on a later pass. Disposal cancels the timer and
waits for a running pass.

## Release

Session release and device unbind remove that session's mappings on the device,
registered as pending device cleanup so the next session waits for it. Ownership
is recorded only after `adb reverse` succeeds, so a session with an `ensure` still
queued or running on the device also counts as owning mappings there: its removal
is queued behind that `ensure` on the device's serial operation chain and removes
whatever it added. Device
removal from the pool forgets `sessionless` ownership without sending a command:
the event cannot tell a disconnect or relaunch (whose reverses died with the
transport) from identity replacement (another device on the serial, whose
mappings are not ours). It leaves session-owned mappings alone: Android recovery
removes and re-adds a device while its session stays bound, and that session's
mappings are restored on its next call. A released mapping whose removal fails
(or whose device cannot answer `--list`) leaves `owned`, so it is never restored,
and waits in a pending-removal set: the device's next `--list` retries the
removal while the port still maps to the host port AutoMobile set, and drops it
once the port is gone or re-pointed. When release reports that another device
now answers on the serial (identity replacement), the session's ownership and the
device's pending removals are forgotten without sending any command.

## Policy

Device and host ports must be 1024-65535 and, when
`AUTOMOBILE_PORT_REVERSE_ALLOWED_PORTS` is set, inside its ranges. An invalid
value allows nothing. The host side is always `tcp:<port>` on loopback. Ensure,
remove and restore are audit-logged at info with device and session.
