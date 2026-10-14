# Managed device slots

Managed device slots let a runner start one AutoMobile STDIO MCP proxy per
execution, declare which local slot that execution is, and have AutoMobile
assign, provision, reuse or replace the Android emulator or iOS simulator for
it. The caller does not preselect devices or call lifecycle tools. The design is
tracked in epic #11172; this page is the published contract (#11180).

## Status

The feature is merged on `main`: launch config, acquisition before `initialize`,
spec reconciliation (create, reuse, adopt, replace), end-of-execution drain,
enforcement across tools, scope reset and abandoned-scope reclaim. The
`managed-slots/v1` capability is advertised by the daemon.

Live acceptance on Android (private daemon, real STDIO proxies, API 36 arm64
image) passed the epic's six-step scenario below. Evidence: the
managed-slot rerun report for #11172 / #11180. Live acceptance on iOS
simulators (iOS 26.5 and 27.0 runtimes) also passed the six-step scenario,
including an omitted `deviceType` resolving to an installed iPhone model and a
cross-platform replace from Android to iOS in the same slot. Follow-ups from
that run are tracked in #11271.
Nothing here is in a released package until the next release is cut.

Known gaps at the time of writing:

- `listDevices` on a managed connection failed output-schema validation in the
  Android acceptance run (fixed on `main` by #11269; not re-verified live).
- A well-formed but not-installed Android system image is refused before any
  device is created with `spec_unsupported`, naming the installed images
  (fixed on `main` by #11269; the acceptance run saw a generic `provision_failed`).
- `setActiveDevice` on a device outside the connection is refused with a
  typed refusal on `main` (#11269); the acceptance run saw an untyped message.
- From the iOS run, fixed on `main` by #11271 and not re-verified live: a refused
  `deleteDevice` on a slot device no longer aborts the slot's in-flight
  acquisition; `killDevice` is refused on a managed connection, own slot device
  included; `observe` of a non-slot device from a managed connection reads it
  instead of failing on the session binding; a malformed or uninstalled iOS
  runtime, or an unknown iOS device type, is `spec_unsupported` before anything
  is created.

## Concepts

| Concept                   | Meaning and lifetime                                                                                                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scoped slot identifier    | A caller-declared numeric `slotIndex`, qualified by `managedHostScope`, `runnerNamespace` and `runnerIncarnation`. Two runners that both use `0` do not share an identity. The registry derives a `scopeKey`, the SHA-256 hex digest of the three scope parts.                        |
| Slot-to-device assignment | AutoMobile's host-local mapping from a valid scoped slot to a stable device identifier (AVD name or simulator UDID) and the spec it was resolved against. It survives the execution proxy exiting. Binding commits and entry into fencing states advance the assignment `generation`. |
| Live session ownership    | The fresh session, held by the current STDIO proxy, that may control the assigned device. AutoMobile owns heartbeat, expiry and cleanup.                                                                                                                                              |
| Execution capacity        | The caller's own local concurrency permit. Releasing it does not erase the assignment or free the device for other slots.                                                                                                                                                             |

An idle assigned device is not an unassigned device. Ending the live session
clears only the execution owner; the assignment stays, and the device is not
returned to the generic pool. A device assignment is not a session UUID and is
not an externally renewed lease. The resident daemon and the per-execution proxy
keep their usual split: the device and its assignment can outlive the proxy.

The assignment `generation` is a monotonic fencing counter for a slot within its
scope, not a count of devices; it only grows and may skip (#11712). Every binding
commit consumes one, even when a changed spec keeps the same device; widening
then narrowing such a spec can move `1 → 2 → 3`. Entering `replacing`, `settling`
or `cleanup_pending` from a different state also consumes one. A replacement can
move `1 → 4`: fencing for deletion (`2`), committing the empty binding before
creation (`3`), then committing the new device (`4`). An unchanged ready binding
and a release that never enters `settling` keep the generation. A new incarnation
has a new scope: a slot starts at `0` and its first binding commit reaches `1`.
An adopted device keeps its name: its `-gN-` records the generation used by the
scope that created it, not its current `assignmentGeneration`. Compare generations
for equality or ordering within the same scoped slot, never as consecutive device
numbers.

The registry is host-wide (the same root iOS claims use), not the per-daemon
`AUTOMOBILE_DB_DIR`, so several daemons on one host see one set of assignments.

There is no caller-supplied operation identity and no receipt replay. A retry of
the same `(scope, slot, spec)` converges on the committed assignment through the
scoped slot identity, the assignment generation and AutoMobile's internal
journal; a new execution simply gets a fresh session.

## Launch configuration

The launcher passes a trusted JSON config to the STDIO proxy, either:

- `--managed-slot-config <json|path>` (also `--managed-slot-config=<json|path>`), or
- the environment variable `AUTOMOBILE_MANAGED_SLOT_CONFIG`.

The flag wins over the environment. A value starting with `{` is inline JSON;
anything else is a file path. The config is incompatible with
`--initial-session-uuid` and `--no-proxy`. Only the launching process can set
it; agent-facing tools cannot change it. Parsing is strict (unknown fields are
rejected) and happens before any daemon or device work.

| Field                  | Type                   | Notes                                                                                                                                                         |
| ---------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contractVersion`      | `1`                    | Required. Any other value fails with `contract_unsupported`.                                                                                                  |
| `managedHostScope`     | string, 1-256 chars    | Required. Identifies the managed host.                                                                                                                        |
| `runnerNamespace`      | string, 1-256 chars    | Required. Identifies the runner.                                                                                                                              |
| `runnerIncarnation`    | string, 1-256 chars    | Required. Identifies the runner's boot. A new value starts a new scope.                                                                                       |
| `executionAttempt`     | string, 1-256 chars    | Optional. Correlation only, never authorization.                                                                                                              |
| `localSlotCapacity`    | integer >= 1           | Required. V1 accepts exactly `1`.                                                                                                                             |
| `requests`             | array, at least 1      | Required. V1 accepts exactly one request. Duplicate `slotIndex` values are invalid.                                                                           |
| `preparationTimeoutMs` | positive integer       | Optional. Upper bound is `MAX_PROVISION_DEVICE_TIMEOUT_MS`.                                                                                                   |
| `idleTimeoutMs`        | integer 120000-3600000 | Optional. Stored idle window: 2 to 60 minutes, default 2 minutes; live-owned executions are exempt.                                                           |
| `executionOwnerPid`    | positive integer       | Optional. Supervising process whose exit ends the execution even while the proxy's parent lives (for example a wrapper shell). Defaults to the launch parent. |

If `executionOwnerPid` is set, the proxy checks at startup that it names a
running process and otherwise fails with `managed_slot_config_invalid`.

Each entry of `requests`:

| Field             | Type                     | Notes                                                                                                                                                                                                                                                                           |
| ----------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slotIndex`       | integer >= 0             | Local slot number within the scope.                                                                                                                                                                                                                                             |
| `role`            | string, 1-256 chars      | Role key for the slot.                                                                                                                                                                                                                                                          |
| `platform`        | `"android"` or `"ios"`   | Selects the spec schema below.                                                                                                                                                                                                                                                  |
| `requestedSpec`   | object                   | Android: `runtime` (system image id), optional `deviceType`, `deviceFamily`, `displayCutout`, optional `configuration`. iOS: `runtime`, optional `deviceType`, `deviceFamily`, `displayCutout`. `deviceFamily` is `"phone"`, `"tablet"` or `"foldable"`. Strict: no other keys. |
| `priorDeviceHint` | `{ "stableId": string }` | Optional and non-authoritative: a prior assignment's stable id may be tried first, never trusted.                                                                                                                                                                               |

`deviceType` is optional for managed slots (an omitted field is unconstrained,
see Spec matching). The spec schemas are `androidManagedSlotSpecSchema` and
`iosManagedSlotSpecSchema` in `src/server/provisionDeviceSpecSchemas.ts`. There
is no `name` (AutoMobile generates device names) and no `operationId`.

### Worked launcher example

This is the Android config used in the acceptance run (step 1, `p1.json`),
launched against a private daemon. The `preparationTimeoutMs` of 820000 is large
because a cold create plus boot took about 38 s on that host and the launcher's
MCP initialize timeout must be at or above it.

```json
{
  "contractVersion": 1,
  "managedHostScope": "host-1",
  "runnerNamespace": "runner-A",
  "runnerIncarnation": "boot-1",
  "executionAttempt": "p1",
  "localSlotCapacity": 1,
  "preparationTimeoutMs": 820000,
  "requests": [
    {
      "slotIndex": 0,
      "role": "main",
      "platform": "android",
      "requestedSpec": {
        "runtime": "system-images;android-36;google_apis;arm64-v8a",
        "deviceType": "pixel_6"
      }
    }
  ]
}
```

The launcher starts the proxy as the MCP server command, with the config as a
file path (or inline JSON, or the env var):

```bash
auto-mobile --managed-slot-config /path/to/p1.json
# equivalent
AUTOMOBILE_MANAGED_SLOT_CONFIG=/path/to/p1.json auto-mobile
```

The acceptance driver spawned the built `dist/src/index.js` with
`--managed-slot-config <file>` over an MCP STDIO client. Result: `initialize`
took about 38 s, outcome `ready`, disposition `created`, 26 tools listed, and
the same payload was readable as the resource `automobile:managed-slots`.

### Version negotiation

Contract v1 is advertised as the daemon capability `managed-slots/v1` in
`daemon/capabilities` (`MANAGED_SLOTS_V1_CAPABILITY`). A launcher that needs
slot mode should fail before any mutation when that capability is absent. A
build that does not wire slots (`MANAGED_SLOTS_PROXY_WIRED` false) refuses a
supplied config with `managed_slots_unsupported` instead of running unmanaged;
on `main` it is `true`. A config with an unsupported `contractVersion` fails with
`contract_unsupported`, and the version is checked before any other field so a
newer contract's shape reports that code, not a schema error.

Optional spec fields added after v1 are advertised as their own capability
tokens. `deviceFamily` requires `managed-slots/v1.deviceFamily`
(`MANAGED_SLOTS_V1_DEVICE_FAMILY_CAPABILITY`). A new proxy connected to an older
daemon refuses a config using `deviceFamily` before sending the acquisition,
with non-retryable `contract_unsupported`; the message names the field and the
missing capability, and nothing is changed. Upgrade the daemon, or restart a
stale running daemon when the proxy starts it automatically from the same
installation; alternatively, remove `deviceFamily` from the config. A config
without `deviceFamily` works unchanged against an older daemon. An older proxy
connected to a newer daemon has nothing to negotiate: the older proxy's own
schema rejects `deviceFamily` at launch as `managed_slot_config_invalid`. A raw
socket client that skips the probe and sends an unknown spec key to a daemon
still gets strict `managed_slot_config_invalid` naming the key.

### Mixed versions and upgrades

Every daemon on a host shares one registry file (see Concepts; the
`AUTOMOBILE_ADB_SERVER_COORDINATION_DIR` override creates a separate one). That
file is the host coordination boundary. Each frontend (STDIO proxy) talks to
exactly one daemon over its socket. The registry schema is the set of slot
registry migrations a build knows (`SLOT_REGISTRY_MIGRATIONS`). It is
independent of `contractVersion` and of the capability tokens.

| Combination                                                                                                                                              | Supported | Behaviour                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current daemon opening a registry written by an older slot schema                                                                                        | yes       | Migrated forward on open, under the cross-process migration lock. Assignments, execution owners, journal entries, free-pool deletion markers and total-resource charges are kept. Pinned by a captured schema-004 registry.                                |
| Daemon restarted against a registry it already migrated                                                                                                  | yes       | No migration runs. State is read as it was left.                                                                                                                                                                                                           |
| Daemons with the same registry schema sharing one registry                                                                                               | yes       | The normal multi-daemon case.                                                                                                                                                                                                                              |
| Daemon opening a registry migrated by a newer build (unknown migration names)                                                                            | no        | Non-retryable `registry_schema_unsupported` before any write: no bookkeeping table, lock row, migration or DDL. Acquisition fails with that code. Generic device reads fail closed with `discovery_incomplete`. Upgrade every daemon sharing the registry. |
| Older daemon left running while a newer daemon migrates the shared registry                                                                              | no        | The refusal runs only when a daemon opens the registry. A daemon that opened it earlier is not re-checked. Stop or restart every daemon sharing the registry when you upgrade one.                                                                         |
| Daemon from a package without managed slots (0.0.84 and earlier) on a host with slots                                                                    | no        | It never reads the registry, so it cannot honour assignments. Do not run it beside a managed-slot daemon on the same devices.                                                                                                                              |
| Newer frontend connecting to an older daemon that it may restart                                                                                         | yes       | The proxy restarts the daemon from its own installation before acquiring, so both sides match.                                                                                                                                                             |
| Frontend and daemon versions or builds that still differ (older frontend, auto-start disabled, restart did not match, or a daemon swapped after connect) | no        | Non-retryable `contract_unsupported` before the capability probe or acquisition. Restart the daemon from the frontend's installation (`auto-mobile --daemon restart`). Nothing was changed. A restart `cooldown` stays retryable `daemon_unavailable`.     |
| Frontend that requires `managed-slots/v1`, with a daemon that does not advertise it                                                                      | no        | `contract_unsupported` before the acquisition is sent. A daemon advertising only unknown tokens (for example a future `managed-slots/v2`) is treated the same way.                                                                                         |
| Frontend with a daemon that advertises `managed-slots/v1` plus unknown extra tokens                                                                      | yes       | Unknown tokens are ignored. The acquisition request is identical to the one sent to a daemon that advertises only `managed-slots/v1`.                                                                                                                      |
| Config `contractVersion` other than `1`                                                                                                                  | no        | `contract_unsupported` before any daemon call.                                                                                                                                                                                                             |
| Frontend using an optional field (`deviceFamily`) with a daemon lacking its capability                                                                   | no        | `contract_unsupported` before the acquisition is sent (see Version negotiation above).                                                                                                                                                                     |

Any unknown migration name makes the schema unsupported, even an additive one.
There is no partial-compatibility list. An upgraded fleet must restart all of
its daemons together. The refusal is new: builds before it open a newer registry
without checking (#12060). Clients without handshake fields skip the identity
gate (legacy clients). The recording-teardown health marker is daemon-local and
in memory. It is not part of the registry. After a restart, the per-daemon
database's persisted recorder teardown state redrives it.

## Lifecycle

Acquisition happens before the MCP `initialize` response, on the same STDIO
connection used for tools and resources:

1. **Acquire.** The proxy sends the config to the daemon
   (`daemon/acquireManagedSlots`) before it connects the MCP server, under one
   `preparationTimeoutMs` deadline that aborts on SIGTERM or stdin EOF. The
   daemon admits the scope, reconciles the slot to its spec and hands back the
   result.
2. **Fresh session.** The execution receives its own slot-tagged live session
   (`sessionUuid`) on the `managed-execution` liveness policy. A later execution
   on the same slot gets a new UUID; it never resumes an old one. Because the
   UUID is new, session-scoped device-state resets (#11145) apply to each
   execution.
3. **Hold.** The proxy holds the session for the whole execution, renewing the
   owner heartbeat. Only the owner's heartbeats keep it alive. The daemon also
   refuses `daemon/registerSession` binding to managed sessions it cannot prove it
   holds (`managed_slot_registration_refused`, a protocol answer rather than a
   device-tool refusal). A daemon restart does not end the execution: its session
   is rehydrated, the proxy re-binds, and the restarted daemon records itself as
   the slot's owner. If registration arrives before the session is rehydrated, the
   proxy retries on the same confined socket at 50 ms doubling to 1 s, then every
   1 s, until it binds or the execution ends. The daemon's `retryAfterMs` floor
   still wins (currently 500 ms for rehydration or an owner claim still pending).
   A present managed session awaiting its owner token stays confined and retryable;
   another token, a non-managed session or a terminal release is refused permanently.
   Failed attempts log at debug; after more than 60 s one warning names the scope,
   session UUIDs, elapsed time, attempt count and last failure. A successful retry
   logs elapsed time and attempt count once. Shutdown stops retries quietly; the
   next connection re-binds. While the daemon is away,
   tool calls answer `daemon_stalled`
   after automatic recovery is exhausted. Its message names the affected sessions
   and attempt count, with `recovery.action: "wait_for_managed_reclaim"`: the proxy
   keeps probing every heartbeat interval, however long the daemon was away, and
   reclaims the session itself once a daemon answers again. Do not pass a `sessionUuid`
   or try to acquire a device; retry the call later. The proxy never restarts the
   shared daemon. If no daemon comes back, restarting it or relaunching the execution
   is the runner's decision. If the session turns out to be released, calls answer
   `managed_execution_ended`. The next call after reclaim carries `daemon_restart_resumed`
   when the daemon restarted, or `daemon_stall_resumed` when the same daemon resumed.
   The restarted daemon waits lease + suspect grace (about 8 s) for the owner.
   During reclaim, reasonless not-found answers and `daemon-shutdown` or
   `daemon-restart` answers are awaited for the existing rehydration window, once
   per answering daemon instance; silence never resets that window.
   If the execution ends, every managed answer, notification and resource reports
   the daemon's release reason, or `session-not-found` when none was named. While the session is live, a duplicate proxy still gets
   `slot_in_use` and the scope is never treated as abandoned.
4. **Drain and release.** When the execution ends (stdin EOF, cancellation or
   owner loss) the proxy releases its sessions with a bounded wait
   (`MANAGED_EXECUTION_RELEASE_TIMEOUT_MS`, 1.5 s). A closing proxy first
   cancels its own tool calls and resource reads still in flight (a process
   stopped by a signal closes with them open), because the daemon admits the
   release in arrival order on the proxy's connection; their callers get a
   "MCP proxy is closing" error. The daemon cancels the
   session's in-flight work, waits about 500 ms for it, then releases the session
   (about 700 ms budget). If everything settled, the slot is
   `reusable_for_this_slot`. If work outlived the budget the slot is marked
   `settling` before its owner is cleared, so the next acquisition waits
   (retryable `slot_settling`) until the work ends or the settler is found dead.
   The slot registry is shared by every daemon on the host and can be busy, so no
   registry step of the drain is assumed to have happened (#11616). A failed
   slot lookup, `settling` mark or return to `ready` is retried with backoff
   (250 ms doubling to 5 s) until the 5-minute settlement cap, then every 30 s
   until it lands or the daemon stops. A failed owner clear is retried the
   same way: the record it leaves belongs to an ended session and pins nothing
   in the draining daemon, but it names that daemon's running process, so other
   daemons on the host answer `slot_in_use` for it until the retry lands. The
   retry clears only that ended session's record; one a live execution holds
   again is left to that execution's own release. Failed acquisition back-out also
   retries owed session release and owner clearing in the background, at 25 ms
   doubling to 1 s until it lands or the daemon closes. Each retry's session release,
   ownership read and owner clear share one 700 ms deadline. Back-out retries,
   execution re-owning and settled-slot recovery take turns in arrival order and
   share one quiet period on the daemon's timer. An expedited re-own may pass
   attempts that are only waiting out quiet time. After a blocked attempt, they wait at least as
   long as that attempt took (at most 5 s). The inline first back-out takes no turn
   and waits for no quiet period; the acquisition answer never waits for retries.
   A back-out attempt abandoned at its 700 ms deadline (for example, a hung session
   release) still takes its turn and its quiet time, delaying re-own attempts
   queued behind it by those durations.
   It clears only the backed-out session's
   record belonging to that daemon and preserves the device assignment. If the
   `settling` mark itself cannot be written, the slot keeps its owner record and
   the daemon keeps treating that owner as live for as long as the released work
   runs, so the slot is never handed to the next execution under running work;
   `reset-slot-scope --force` reports such a slot as `live_owner`. An explicit
   release whose slot lookup fails is rejected before anything is cancelled or
   released.
   What tells every daemon on the host that released work is still running is
   in the registry and names the draining daemon's process: the `settling` mark,
   or, until that mark lands, the owner record. Before it marks a slot the
   daemon re-stamps an owner record that still names another process (the
   previous daemon after a restart, or a second daemon) with itself, so a slot
   whose mark is owed reads `slot_in_use` from any daemon. Both hold for as long
   as that process runs, including after it has begun to shut down, and neither
   outlives it: once the process is gone its work is gone too, the next daemon
   returns a `settling` slot to `ready` at startup, and the owner record reads
   dead. A mark whose write was committed although the call failed is read back
   and treated as written. One window has no registry record: while neither the
   re-stamp nor the mark of such a foreign record has landed (or the lookup of
   a session released by heartbeat loss has not), only the draining daemon
   itself refuses the slot. And an owner record whose clear failed, which the
   draining daemon itself reads as dead, still names that daemon's process:
   other daemons on the host answer `slot_in_use` for it until the clear's
   retry lands, the draining daemon next claims the slot, or it exits.
   A release clears the execution owner and keeps the device assignment and spec,
   whatever the release reason (explicit or owner/heartbeat loss). The generation
   stays unchanged unless the slot enters `settling`; entering it to fence
   undrained work, an unconfirmed session release or unfinished cleanup advances
   it by one.
5. **Reuse.** A new proxy with the same scoped slot and a matching spec reuses
   the assigned device with a fresh session. A duplicate proxy for a slot whose
   execution is still live is refused with a retryable `slot_in_use`.

## Idle and liveness

A managed-execution session uses the `managed-execution` liveness policy:

- **Heartbeat.** Same lease as an ordinary heartbeat session: a 4 s lease plus a
  4 s suspect grace, so about 10 s after the last owner heartbeat the session is
  released. Tool calls from other callers do not keep a dead owner alive.
- **Idle exemption.** While the owner heartbeat lease is live or suspect, the execution
  never idle-releases, even after 30 minutes or its declared `idleTimeoutMs`. A hung but
  living owner with a healthy proxy heartbeat holds the slot indefinitely. Heartbeats and
  reads still never move tool-activity clocks. The trusted config's `idleTimeoutMs`
  (2 to 60 minutes, default 2 minutes) stays validated, stored and reported; it does not
  end a live-owned execution. Out-of-range values remain `managed_slot_config_invalid`.
  `session-info` and requested heartbeat reports give `idleReleaseAt: null`; the proxy
  treats null as authoritative and never substitutes its local idle window.
  Once the owner lease lapses, `session-info` reports a numeric `idleReleaseAt` again;
  the release that follows is `heartbeat-timeout`, or `rehydration-owner-timeout` for a
  rehydrated execution whose proxy never returns (no release if it returns), without an `idle` flag.
- **Execution end is terminal.** Owner exit, heartbeat loss or explicit release ends the
  UUID. A call on the managed connection then answers `managed_execution_ended`
  (`nextAction: relaunch_execution`, release reason, `slotIndex` and
  `assignmentGeneration`; no recovery tools). Heartbeat loss carries no `idle` flag.
  Explicit deviceId reads still work; reads without a deviceId require a new execution.
  The slot keeps its device assignment, so a new execution reuses it with a fresh UUID.
- **Daemon restart.** A passed persisted idle deadline never prevents managed recovery.
  A returning proxy reclaims the session; a proxy that never returns loses it under the
  existing awaiting-owner timeout. Terminal releases, retention and the fixed
  device-restart recovery window still apply. Plain sessions keep the 2-minute rule.
  A managed row skipped because its device is unavailable at boot remains re-issuable
  through the released-row retention window, rather than ending at its idle deadline.
  Each later daemon start retries its device reservation while the row is recoverable;
  failed rehydration frees that reservation immediately, while successful rehydration
  holds the device until the proxy returns or the awaiting-owner timeout ends the session.
  A rehydrated execution with unconfirmed slot ownership (registry busy) stays held
  while its proxy heartbeats; control calls return `managed_slot_ownership_unconfirmed`
  until ownership is confirmed or lost.
- **Execution owner.** The proxy checks every second that its owner (by default
  the parent process that launched it, or `executionOwnerPid`) is running and,
  for the default owner, that it has not been re-parented. Either loss shuts the
  proxy down and releases its sessions. The owner is identified by PID plus OS process
  start identity where readable, so a reused PID counts as the owner having exited;
  where that identity cannot be read, the PID alone is used. Stdin EOF ends the execution the same
  way. If the proxy is killed outright, the ~10 s no-heartbeat release applies.
  See [Execution owner PID reuse](#execution-owner-pid-reuse) for the measured limits.
  Limit: with the default owner, a launch parent pid of 1 is treated as already
  orphaned and a parent pid of 0 (for example `docker exec`) as exited. When the
  runner is PID 1 in a container, or the proxy is started by `docker exec`, set
  `executionOwnerPid` to a live pid; an explicit owner takes precedence over the
  parent-pid heuristic.

The registry's execution owner record (`exec_owner_daemon_id`, `exec_owner_pid`,
`exec_owner_process_token`, `exec_session_uuid`) names the **daemon** holding the
session, not the proxy or runner (#11711). Host daemons use it to identify the
recorded owner and check whether that daemon still runs, using its PID and process
start identity (falling back to the PID when that identity is unavailable).
Client liveness is separate: the session's proxy heartbeat lease and the proxy's
execution-owner watch; `executionOwnerPid` is never written to the registry.
After a daemon restart, the persisted record still names the previous, dead
daemon until the execution is re-owned, a new execution claims the slot, or the
record is cleared. A dead record alone never keeps a slot in use; a live session
held by the current daemon can still do so while re-owning catches up. The `pid`
in `reset-slot-scope` pending `liveOwners` evidence is this recorded daemon PID.

While re-owning is unconfirmed, control calls refuse with
`managed_slot_ownership_unconfirmed` and `retryAfterMs: 1000`; retries start at
25 ms, double to a 1 s cap, and continue while the session remains unconfirmed.
Back-out cleanup, re-own and settled-slot recovery take turns in arrival order and
share quiet time after a blocked registry call (capped at 5 s). An expedited re-own
may pass attempts that are only waiting out quiet time. Asynchronous waits are
bounded at 700 ms; failures warn once after 5 s of unconfirmed ownership.
A release while ownership is unconfirmed holds device teardown for up to 1.9 s on the
daemon’s timer: two shared turns at their worst case (700 ms attempt bound + the
registry’s 250 ms busy timeout each), covering the turn in flight when the hold is
created and the hold’s own expedited attempt. Creating the hold expedites one waiting
re-own attempt without overlapping another session's attempt.
Confirmation starts teardown early; proven ownership loss skips device writes. At the
cap, device writes are skipped and one warning says saved device state was dropped
because ownership could not be confirmed. Ownership retries continue while the session
object remains present. More than one eligible attempt queued ahead is still not
guaranteed to fit within the cap.
A synchronously blocked registry write crossing the cap delays it by at most that write;
device writes are skipped in that case, and the cap-derived `device_cleanup_in_progress`
hint is short by the blocked time.

Values are the defaults in `src/daemon/sessionLivenessWindows.ts`; see
[Device ownership](device-ownership.md#when-a-session-is-released) for the
general release rules.

### Execution owner PID reuse

The execution-owner watch records the owner as a PID plus the OS process start
identity, and compares both on each check. On Linux the start identity is
`/proc/<pid>/stat` field 22 plus the boot ID. On macOS it is the process start time.
This section gives the numbers behind that design. They were measured for #12060
on one macOS host (Darwin 25.6.0) under heavy parallel load (load average 250 to 400).

| Measurement (macOS)                                              | Result                                                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------- |
| PID range                                                        | Sequential up to 99,999, then wraps to 100                  |
| Background PID allocation on the host                            | About 26 per second, so a given PID returns after about 1 h |
| Spawn loop, 8 in parallel, until one exited PID was handed out   | 95,528 spawns in 69 s (1,377 per second)                    |
| Serial spawn loop until a real successor held the owner's PID    | 177,990 spawns in 356 s                                     |
| `sysctl kern.proc.pid` start time (in-process, `bun:ffi`)        | p50 0.03 ms, p95 0.04 ms                                    |
| `ps -p <pid> -o lstart=` start time (child process, synchronous) | p50 6.4 ms, p95 51 ms, timeout 1 s                          |
| Start identity from sysctl compared with `ps`                    | Identical for 1,889 of 1,889 host processes                 |

What this means:

- **The PID check alone is almost always enough.** The watch probes once a second, so
  a PID-only check is fooled only if the owner's PID goes to a new process less than
  a second after the owner exits. That needs a full PID wrap within one second, about
  70 times faster than the fastest rate measured above. The start identity covers
  the cases where checks pause for longer: a suspended proxy (laptop sleep,
  `SIGSTOP`) or a long event-loop stall.
- **Real reuse is detected.** In a native check, a real successor process held the
  former owner's PID and `kill(pid, 0)` reported it alive. The watch with the
  recorded start identity reported `owner-exited`. A watch with the PID alone
  reported the owner as still alive.
- **The identity is read cheaply on both platforms.** On macOS the proxy reads it in
  process through `sysctl`, which works for processes of any user, including
  PID 1. It compares the identity on every 1 s check. A matching result is cached for
  1 s, so in practice a fresh read happens every 1 to 2 s. If `bun:ffi` cannot load,
  the proxy falls back to `ps` and compares every fifth check, so reuse is detected
  within about 5 s. On Linux, reading `/proc` is cheap and the identity is compared on
  every check. Linux PID wrap rates were not measured. The default `pid_max` is
  32,768, or 4,194,304 where systemd raises it (`/proc/sys/kernel/pid_max`).

Known limits:

- The identity is captured when the proxy starts, not when the runner chose
  `executionOwnerPid`. If that PID already names a different process when the proxy
  launches, the proxy adopts that process as the owner. Pass the PID of a process that
  outlives the proxy launch, such as the runner itself.
- If the identity cannot be read at startup, for example because `ps` timed out, the
  watch uses the PID alone. It retries the capture on later checks and switches to
  PID plus identity once the read succeeds.
- Windows has no start identity, so the owner is judged by PID alone.

### Peer daemons and database lock contention

Daemons sharing a data directory share `auto-mobile.db` (#11158, #11858).
A peer's write lock blocks the event loop for one nominal 250 ms wait per attempt;
the dialect yields between attempts within a 5 s per-statement retry budget
(an in-flight attempt may exceed the budget by one wait plus backoff).
The registry remains bounded at one nominal 250 ms wait per operation (#12104).

| Session upsert: peer hold | Before: total / longest stall (ms) | After: total / longest stall (ms) |
| ------------------------- | ---------------------------------- | --------------------------------- |
| 1 s                       | 1007 / 1007                        | 1002 / 254                        |
| 3 s                       | 3005 / 3005                        | 3011 / 258                        |
| 8 s                       | 8001 / 8001                        | 8001 / 508                        |
| 20 s (refused, busy)      | 10003 / 10003                      | 10305 / 504                       |

Measured on macOS with Bun 1.3.14. The upsert runs two statements (prune, then write), so
its longest stall can be two adjacent waits; single-statement writes and transactions stayed
at or under 262 ms, and the per-statement success window is unchanged (about 5 s).

Reproduce: `bun scripts/db/peer-write-lock-stall-probe.ts --holds 1000,3000,8000,20000`.

## Spec matching

Matching is declarative, per slot, and the result reports a `disposition` of
`created`, `reused`, `adopted` or `replaced`:

- **Omitted fields are unconstrained.** An assigned device with any value for an
  omitted field matches. Without `deviceFamily`, an omitted `deviceType` matches
  any model on the requested runtime, including an iPad, even though creation
  defaults to a phone. With `deviceFamily: "phone"`, "iPhone on iOS 27.0, any
  model" reuses an eligible non-default iPhone and rejects an iPad. Original
  constraints are applied to assigned and eligible cached devices before
  creation defaults are used. A changed creation default alone never forces
  replacement. `requestedSpec` retains the constraints, including `deviceFamily`;
  `resolvedSpec` reports the device's actual configuration without that field.
  `specFingerprint.version` remains the existing configuration-policy version.
- **Empty slot (`created`).** The device is created from the spec, with
  deterministic platform defaults filling gaps, and proven ready by a targeted
  observe. If a free-pool device (from a retired scope) matches, it is
  **adopted** instead.
- **Assigned and matching (`reused`).** The device is reused with a fresh
  session. If it was deleted out of band, it is recreated.
- **Assigned and not matching (`replaced`).** The slot's device is exclusively
  deleted and absence is verified before the replacement is created and recorded
  in the same slot. Replacement can cross platforms (a slot that held an Android
  emulator may be replaced with an iOS simulator). If deletion fails, the old
  assignment is kept and marked cleanup pending (`cleanup_pending`); replacement
  never starts from a partial inventory (`discovery_incomplete`).
  Boot capacity is checked before the old device is deleted, so a replacement
  refused at the limit (`capacity_exhausted`), or with an unknown booted count
  (`discovery_incomplete`), leaves the old device in place (#11433). Reuse and
  adopt are not pre-checked: nothing is deleted first, and provisioning's own
  exemption for the slot's own device applies.
- Generic `provisionDevice` keeps its existing `identity_conflict` behavior;
  destructive mismatch replacement exists only for managed slots.

Before deleting or creating a device, Android hardware profiles (including creation defaults)
are checked against `avdmanager list device`: an unknown profile returns non-retryable
`spec_unsupported`, and an unreadable catalog returns retryable `discovery_incomplete`.
Reuse and adoption do not require this creation-only catalog check.

`deviceFamily` uses the shared `phone`, `tablet` and `foldable` vocabulary.
On both platforms, any model or profile identifier containing `fold` or `flip`
(case-insensitive) is classified as foldable before other family hints.
For example, an iPhone "Fold" type is foldable and mismatches a `phone` request.
Other iOS identifiers are classified from `iPhone` or `iPad`. On Android,
Pixel Tablet and Nexus 9/10 profile hints are tablets. Otherwise the AVD's display
width, height and density determine phone versus tablet (a diagonal of at least
7 inches is a tablet).
Unknown family evidence returns `discovery_incomplete` for an assigned device;
it never authorizes deletion.

When creation is needed, Android defaults are `pixel_8` for phone,
`pixel_tablet` for tablet and `pixel_fold` for foldable. Resolver options can
override these per family; the existing Android default option still supplies
the phone default. iOS selects the newest catalog model of the requested family
known to support the runtime, otherwise the newest whose support is unknown.
Without a family, it keeps the existing newest-iPhone rule. No compatible iOS
family/model returns `runtime_incompatible`, naming the family and runtime.

An explicit model and family must agree. A conflict returns `spec_unsupported`.
The same code refuses a model whose family cannot be verified before creation:
most Android phone profile IDs (for example `pixel_8`) need AVD geometry, and
an iOS type containing none of `fold`, `flip`, `iPhone` or `iPad` cannot be
classified. Request either `deviceType` or `deviceFamily`, not both, for these models. A
`displayCutout` other than `"any"` still requires an explicit `deviceType`.
On Android, `deviceFamily` together with any of `configuration.screenWidth`,
`configuration.screenHeight` or `configuration.screenDensity` returns non-retryable
`spec_unsupported` before anything is created or deleted: family is classified
from screen geometry and cannot be verified before creation when that geometry
is overridden. Request `deviceFamily` without screen overrides, or an explicit
`deviceType` without `deviceFamily`. Other configuration fields such as
`memoryMb` remain allowed with `deviceFamily`; screen overrides without
`deviceFamily` remain supported.
These constraint forms are refused rather than silently dropped. `deviceFamily`
requires daemon capability `managed-slots/v1.deviceFamily`; see
[Version negotiation](#version-negotiation) for the early `contract_unsupported`
refusal when it is absent. The public `provisionDevice` tool does not accept
`deviceFamily`; this field belongs only to managed-slot requested constraints.

Created devices are named `amslot-<scope prefix>-<slot>-g<n>-<suffix>`; treat
the name as opaque. The `g<n>` number tracks the journal entry, not a per-slot
count (the acceptance run saw `g1` then `g4` after one replacement).

## Scope reset and abandonment

The registry tracks each scope as `valid`, `invalidating` or `invalidated`
(`src/daemon/managedSlots/slotRegistry.ts`).

- **New incarnation (implicit reset).** A trusted config with a new
  `runnerIncarnation` for the same `(managedHostScope, runnerNamespace)` starts a
  transition of the old scope. It waits until no live execution owner, no
  `settling` slot, no `cleanup_pending` slot and no open journal work remain
  (retryable `scope_transition_pending` meanwhile, bounded by the preparation
  deadline), then moves the old scope's devices to a free pool that only managed
  slots can adopt. Other namespaces are untouched. Requests carrying the old
  incarnation are refused with `scope_invalidated`. A daemon restart during the
  wait changes nothing: the restarted daemon still records itself as the owner
  of the execution it holds, so the transition keeps waiting for that execution
  on every daemon of the host. No other session can claim a slot of the retiring
  scope (#11642).
- **Operator command.** Invalidate one incarnation explicitly:

  ```bash
  auto-mobile --daemon reset-slot-scope \
    --runner-namespace runner-A --incarnation boot-1 \
    [--managed-host-scope host-1] [--wait-ms 10000] [--force]
  ```

  `--force` abandons a slot stuck `settling`: one whose released work outlived the
  5-minute settlement cap, or whose settling daemon is gone (its work died with
  it, so the cap is not waited out). The slot returns to `ready`, its release
  journal entry is committed, and the reset proceeds; work that outlived the cap
  may keep running after an abandon. `--force` never overrides a slot with a live
  execution owner, nor a slot still inside the cap whose settling daemon is not
  provably gone. Slots are judged when the command starts and again when its
  settle wait ends, so a slot that outlives the cap, or whose settling daemon
  exits, during the wait is abandoned by the same call, and the refusals in the
  answer describe the moment it answers (#11616). Each slot it leaves alone is
  listed in the scope's `forceRefusals` with a typed `reason` and a message
  saying what to do:

  | `reason`                 | Meaning                                                                                                                                                                                                                                 |
  | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `live_owner`             | An execution this daemon holds is using the slot: release it first. Also a released execution whose work is still running while its `settling` mark could not be written yet (#11616); it clears when that work ends or the mark lands. |
  | `owner_liveness_unknown` | The owner record belongs to another running daemon. This daemon cannot tell whether that execution ended there, so it neither cuts the slot nor treats the record as dead. Run the reset through that daemon, or restart it.            |
  | `within_settlement_cap`  | The slot is settling under a daemon not known to be gone. `remainingMs`, measured when the command answers, says when `--force` will apply.                                                                                             |
  | `no_release_entry`       | The slot is `settling` with no open release entry, so `--force` cannot tell whether it is stuck. Restart the settling daemon: startup recovery returns the slot to `ready`.                                                             |
  | `other_open_journal`     | Unfinished non-release journal work; wait for the redrive.                                                                                                                                                                              |
  | `abandon_failed`         | The slot changed, or the registry failed, during the abandon; retry.                                                                                                                                                                    |

  An owner record whose session has ended in the daemon that wrote it (its clear
  failed against a busy registry) is not a live owner there: that daemon clears it
  when the slot settles, re-checking until the settlement cap if the same session
  id is held again at that moment, and its `--force` does not yield to it.

  `--runner-namespace` and `--incarnation` are required; `--managed-host-scope`
  narrows to one host scope; `--wait-ms` is the bounded settle wait (integer 0 to
  60000, default 10000). The command prints the daemon's JSON result and exits
  `0` when every matching scope is invalidated, `2` when a scope is still waiting
  on owners or cleanup (the result lists the live owners, settling and
  cleanup-pending slots and open journal work; stderr also lists each
  `forceRefusals` entry with its reason, `remainingMs` and message; retry later),
  and `1` when no scope matched or the call failed. It is idempotent and a repeated call resumes
  where it stopped. It accepts the usual daemon launch options. Like the other
  daemon lifecycle commands, it is refused (`shared_daemon_namespace`) when
  `AUTOMOBILE_DATA_DIR` or the DB dirs are set without
  `AUTOMOBILE_AUX_SOCKET_DIR`, because it would act on the shared resident
  daemon; set the aux socket dir to target a private daemon, or pass
  `--allow-shared-namespace` (or `AUTOMOBILE_ALLOW_SHARED_DAEMON_NAMESPACE=1`)
  deliberately.

- **Abandoned scopes.** A scope idle for one hour
  (`MANAGED_SLOT_ABANDONED_SCOPE_THRESHOLD_MS`) with no live owner is abandoned.
  A returning **same incarnation** revives it (`revived: true`). Slots the sweep
  has not yet journaled keep their devices. An already journaled delete, even if
  blocked by a held device or unknown state, always completes first: acquisitions
  answer retryable `device_busy` / `discovery_incomplete` / `cleanup_pending`
  meanwhile. The slot then gets a new device with a later `assignmentGeneration`
  (#11545). Only an explicit reset or a new incarnation invalidates permanently.

Numeric slot `0` can repeat across scopes, but the scoped identity is new each
time.

## Results and failure

On success, the `initialize` result carries the contract under
`capabilities.experimental["automobile/managedSlots"]` and the proxy exposes the
acquisition evidence as the resource `automobile:managed-slots`
(`MANAGED_SLOTS_RESOURCE_URI`, `application/json`). The payload
(`src/models/managedSlotsResult.ts`):

The initialize capability is a snapshot at connect. Resource reads add
`executionEnded` to a slot whose session was terminally released, while preserving
`outcome`, `sessionUuid` (the session that ended) and all other acquisition fields.

| Field                    | Meaning                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contractVersion`        | `1`.                                                                                                                                                                                                                                                                                                                                                       |
| `scope`                  | `managedHostScope`, `runnerNamespace`, `runnerIncarnation`, `scopeKey` (null if it failed before the scope resolved), optional `revived`.                                                                                                                                                                                                                  |
| `outcome`                | `"ready"` or `"failed"`.                                                                                                                                                                                                                                                                                                                                   |
| `idleTimeoutMs`          | The validated, stored idle window; it never ends a live-owned execution.                                                                                                                                                                                                                                                                                   |
| `slots[]`                | Per slot: `slotIndex`, `role`, `platform`, `assignmentGeneration`, `device` (`stableId`, `transportId`, `name`), `sessionUuid`, `requestedSpec`, `resolvedSpec`, `specFingerprint` (`version`, `hash`), `disposition`, `readiness` (`mode`, `status`), `lifecycle` (provision timing and the reconciler's decision trail), and `failure` on a failed slot. |
| `slots[].executionEnded` | Optional `{ reason: string, idle?: true, nextAction: "relaunch_execution" }`, present only in the `automobile:managed-slots` resource after that slot's session was terminally released; owner exit and heartbeat loss carry no `idle` flag; the optional field remains for older release evidence.                                                        |
| `failure`                | Scope- or transport-level failure: `code`, `retryable`, `message`, `nextAction`. Per-slot failures sit on the slot entry.                                                                                                                                                                                                                                  |

If acquisition fails, the proxy still serves MCP: `initialize` reports outcome
`failed` with the typed failure, the tool list is empty, and every tool call is
refused with `managed_slot_acquisition_failed` (the error carries
`acquisitionFailure`; read the resource for the evidence). The launcher must set
its MCP initialize timeout at or above `preparationTimeoutMs`. Launch-config
errors (invalid JSON or schema, `contract_unsupported`, unsupported group size,
dead `executionOwnerPid`) are different: they are raised before the server
starts, and the process exits with the typed code.

Acquisition-level failure codes besides the reconciler's: `contract_unsupported`
(the daemon does not advertise `managed-slots/v1`, or a capability a config field
requires), `scope_invalidated`,
`scope_transition_pending`, `execution_policy_failed`, `daemon_unavailable`,
`timeout` and `cancelled`.

## Enforcement

Reads stay open on every device: `observe` and the other reads listed in
[Device ownership](device-ownership.md) are allowed on a device assigned to any
slot. Only control and lifecycle calls on another slot's device are refused.

- A generic caller (no managed slot) that tries to lend, adopt, start, stop,
  delete or drive a device a slot holds, or one parked in the managed free pool,
  gets the non-retryable `device_assigned_to_managed_slot`. `force: true` does not
  override it. The device frees only when its scope is reset.
- A managed connection (a proxy launched with a slot config) that tries to
  control, start, provision or delete anything outside its own slot devices or
  sessions gets the non-retryable `device_outside_managed_slots`, with a reason
  of `device`, `session`, `tool`, `scope` or `host` (device-acquiring tools are left to slot
  acquisition). A platform-only call (control or read) naming a platform none of its slot
  devices holds is refused with reason `device` and the requested `platform`; a read may
  name a device outside the slots by `deviceId`.
  Lifecycle tools (`getAndroid`, `getApple`, `startDevice`,
  `provisionDevice`, `killDevice`, `deleteDevice`) are refused with reason `tool`
  even on the connection's own slot device: it could not boot the device again,
  so a stop would strand the execution. End the execution instead; the next
  acquisition on the slot boots and reuses the device.
- The same confinement applies to a managed connection's direct socket frames:
  `input/*`, the device-mutating `ide/*` routes (`force` or not),
  `ide/setSessionToolEnabled`, `daemon/releaseSession` and
  `daemon/relinquishDeviceLease` are refused off-slot (#11596).
  `daemon/releaseExecution` is confined to its own slot sessions unless the caller
  presents the recorded owner token of a live managed execution. That owner may
  release its own execution even after a refused rebind leaves the connection
  with zero slot sessions. A foreign token, an ownerless session or a session
  outside the binding that is not a managed execution remains refused.
  `daemon/resetSlotScope` is confined to its own scope named by all three identity parts.
  `daemon/refreshDevices` and `ide/setFeatureFlag` are refused (#11596). An
  ordinary connection may still release any session.
- A managed connection's multi-device plan labels are served only by its own slot
  sessions. Any other label, or one whose declared platform the slot device does
  not match, is refused with `device_outside_managed_slots` before anything is
  allocated or booted. Plan steps cannot acquire, boot, kill or delete devices
  outside the slot set (#11425). Reads of non-slot devices inside a plan still
  work.
- The generic device pool skips assigned and free-pool devices as capacity, idle
  or not. If the registry has never been readable, allocation refuses with
  retryable `discovery_incomplete` rather than treat unknown as free (#11410). A
  host with no registry at all has no managed slots, and devices are free. A
  registry that was read successfully once and then fails keeps its last good
  snapshot for reads and inventory. Taking an unheld device requires a current
  snapshot; a failed read refuses with retryable `discovery_incomplete`.

## Boot capacity

When a platform already runs as many booted devices as its limit allows, a cold
boot is refused at once with the retryable `capacity_exhausted` code instead of
waiting in an internal queue. The error carries `retryAfterMs`, the `limit`, the
`booted` count and `platform`, plus `externalDevices` when counted devices were
not started by AutoMobile. Capacity frees when another device shuts down. A slot
failure refused at the limit carries these as `capacity { limit, booted,
retryAfterMs, externalDevices }` on the initialize outcome, the
`automobile:managed-slots` resource, the daemon socket JSON and a refused tool
call's `acquisitionFailure` (#11402).
`capacity_exhausted` applies to all boots, including a slot that must create or
boot its device.

## Total-resource capacity

`AUTOMOBILE_MANAGED_SLOT_MAX_DEVICES` sets a trusted host-wide limit on distinct
managed Android and iOS resources, separate from each platform's boot limit.
Set a positive safe integer to enforce it. Unset or empty leaves total-resource
admission disabled; an invalid value warns once when the daemon is wired and is
ignored. No consumer configuration exists to validate in aggregate (#12051).

The limit is host-wide only when **every daemon on the host starts with the same
value**. A daemon with the variable unset creates without admission and is not
ordered against participating daemons. All daemons sharing the registry must run
a build with the `deletion_failed_deletes` column: upgrade them together. Older
daemons record attempts without adding failed deletes, so their markers stay counted.
Builds that check the registry schema refuse a newer one outright (see
[Mixed versions and upgrades](#mixed-versions-and-upgrades)).

The ledger counts active devices, assigned idle devices, cached free-pool images
(including stopped images), creation reservations, deleting or cleanup-pending
devices, and inventory orphans whose names start with `amslot-` and whose stable
identity is unknown to the registry. One device is counted once as its reservation
materializes. The registry persists commitments across daemon restarts and scope
resets. Unknown or incomplete registry or inventory reads refuse with retryable
`discovery_incomplete`; unknown never means headroom or a full budget.

A platform whose lister is verifiably not installed contributes zero inventory
orphans to this budget, allowing single-platform hosts to create devices. Its
listing remains incomplete: missing tooling does not prove any specific device
absent. A transient failure of installed tooling still makes total usage unknown.

Under budget pressure, absence is proved by a COMPLETE platform listing at selection
that the journal's own COMPLETE listing inside `driveFreeDeviceDeletion` does not
contradict. On iOS these listings may share one cached simctl observation up to 5 s
old, the same proof the reconciler accepts for an assigned device. A wrongly released
simulator is never deleted and is counted again as an inventory orphan when next
listed. Incomplete discovery at either point proves nothing and releases nothing.
Only `completeFreeDeviceDeletion` removes the row. If the journal lists the image
again, ordinary journaled deletion checks all session, claim, busy and generated-name
holds; the image is deleted first or its marker stays for redrive. Absent candidates
precede listed cache in eviction order.
Without budget pressure, the reclaim sweep requires two complete absence observations
for the same row, one sweep interval apart and therefore independent, plus one more
complete platform listing immediately before journaling deletion. Incomplete observations
neither confirm nor clear that evidence; reappearance clears it and skips deletion.
A device that reappears between the pre-check and the journal's own listing follows
the journaled deletion path with its hold checks. A released row means that journaled
deletion completed and the free row is gone, whether or not a native delete was needed.

Compatible eligible cache is adopted first. Adoption of cache or an orphan is
charge-neutral. Fresh creation opens its journal reservation before native creation.
Concurrent reservations are ordered by the registry's journal id: later fresh
reservations cannot take capacity promised to earlier ones. A replacement keeps its
continuous charge through delete, verified absence, and preparation of its successor.
An over-limit read is confirmed by a fresh independent read before eviction or refusal.

With headroom, unrelated cache is retained. When over the limit, creation is refused
before deleting cache if a counted deletion is still pending or the remaining
eligible caches cannot free enough room. Retry after the pending deletion finishes
or becomes stuck. Creation needing room may evict eligible
unassigned cache from either platform, oldest `freedAtMs` first. Assignments in every
scope (including abandoned but revivable scopes), open journal targets, stopping or
already deleting rows, held devices, foreign claims, incomplete discovery, pooled
work, shutdown/startup leases, and restart-recovery reservations are protected.
Only a listed device with the `amslot-` prefix can be deleted.
Pending deletions with fewer than 3 failed native deletes count as committed room:
admission evicts at most the shortfall not already covered by those markers. If
pending deletions cover the shortfall, creation is refused until redrive confirms
absence or the marker reaches 3 failed native deletes, without evicting newer cache.
Markers with 3 or more failed native deletes do not count as committed room.

Before a cache deletion, a transaction marks its exact free row as deletion pending.
That durable marker fences adoption and shutdown. Only authoritative absence removes
it. A failed native delete is one that ran and did not confirm absence, including a
delete that timed out. A refusal before any native work (including an unregistered
delete workflow), blocked redrives, and a passed preparation deadline never
count as failed native deletes. Failed or unconfirmed deletion remains charged as
`deleting` until its marker has 3 failed native deletes. At that threshold, at most one unbound stuck marker host-wide contributes no
resource charge or reservation ranking: the one whose deletion started first
(ties use platform, then stable device id). Further stuck markers count again as
`deleting`; a device still bound to a slot remains charged and does not consume
the exemption. The marker stays journaled and is still retried with
backoff; the journal owner loop retries it even when that daemon's own limit is
unset, taking over from a dead owner while leaving live foreign owners alone.
No internal job queue is added for capacity refusals.
A journaled delete is never reverted, even if its post-marking safety check finds
the device transiently busy and the creation is refused. Redrive still deletes
that marked cache when it becomes safe.

Admission and eviction are bounded by the acquisition's preparation deadline.
A delete journaled but not confirmed before that deadline stays charged until
3 failed native deletes, when it may receive the single exemption, and is finished by periodic redrive. A
deadline passing during admission returns `timeout`.

A full budget returns `managed_slot_budget_exhausted`, `retryable: true`, with no
`retryAfterMs` because recovery has no time bound. Its `budget` evidence contains
`limit`, category `usage` (including `total` and `orphaned`), protected `retained`
entries with reasons, and `evictionFailures`. Reset or release managed slot scopes
that are no longer needed, or raise `AUTOMOBILE_MANAGED_SLOT_MAX_DEVICES`, then retry.
This refusal is separate from `capacity_exhausted`, which concerns boot limits.
`usage.total` includes the refused request's own `preparing` reservation, so it can
read as the limit plus one or more. Pending deletions are named in `retained` with
reason `deletion_pending` when they have fewer than 3 failed native deletes and
`deletion_stuck` at 3 or more failed native deletes. Both include `attempts`,
`failedDeletes`, and `lastError` (a string or null). A stuck device still exists on
the host and remains protected from adoption and eviction. Real device count can
exceed the limit by at most one uncounted stuck marker at a time. The exempt
`deletion_stuck` row carries `uncounted: true`; other stuck rows omit that field.

## Error codes

| Code                                | Retryable | Meaning                                                                                                                                                                                                                   |
| ----------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `managed_slot_config_invalid`       | no        | Config is not valid JSON, fails the strict schema, has duplicate `slotIndex`, an out-of-range `idleTimeoutMs`, a dead `executionOwnerPid`, or is combined with `--initial-session-uuid` / `--no-proxy`.                   |
| `contract_unsupported`              | no        | `contractVersion` is not supported by this build or daemon, or the daemon lacks a capability a config field requires (`managed-slots/v1.deviceFamily`).                                                                   |
| `registry_schema_unsupported`       | no        | The shared registry was migrated by a newer build. Nothing was changed. Upgrade every daemon sharing it.                                                                                                                  |
| `managed_slot_group_unsupported`    | no        | `localSlotCapacity` or `requests` exceeds one slot and device.                                                                                                                                                            |
| `managed_slots_unsupported`         | no        | A config was supplied but this build does not serve managed slots.                                                                                                                                                        |
| `spec_unsupported`                  | no        | The requested spec is malformed, or names an Android image, iOS runtime or iOS device type this host has not installed; nothing was changed.                                                                              |
| `runtime_incompatible`              | no        | An installed iOS runtime that is unavailable, or outside the requested (or every listed) iPhone model's supported range; nothing was changed.                                                                             |
| `slot_in_use`                       | yes       | A live execution already holds the slot.                                                                                                                                                                                  |
| `slot_settling`                     | yes       | The previous execution's released work is still settling.                                                                                                                                                                 |
| `stale_session`                     | yes       | An earlier execution's session on the slot device could not be released.                                                                                                                                                  |
| `scope_invalidated`                 | no        | The request's incarnation was reset and never accepts work again.                                                                                                                                                         |
| `scope_transition_pending`          | yes       | A scope reset is waiting for owners or cleanup to settle.                                                                                                                                                                 |
| `cleanup_pending`                   | yes       | A prior deletion or release has not been confirmed.                                                                                                                                                                       |
| `discovery_incomplete`              | yes       | Device inventory or the slot registry was partial, so absence cannot be proven.                                                                                                                                           |
| `capacity_exhausted`                | yes       | Boot refused at the platform's booted-device limit.                                                                                                                                                                       |
| `managed_slot_budget_exhausted`     | yes       | Total-resource budget is full. `budget` carries limit, usage, retained reasons and eviction failures; reset/release unused scopes or raise `AUTOMOBILE_MANAGED_SLOT_MAX_DEVICES`, then retry. No retry delay is promised. |
| `device_assigned_to_managed_slot`   | no        | Generic control or lifecycle on a device assigned to a slot (or in the free pool).                                                                                                                                        |
| `device_outside_managed_slots`      | no        | A managed connection touched a device, session or tool outside its own slots.                                                                                                                                             |
| `managed_slot_acquisition_failed`   | no        | Tool call on a proxy whose acquisition failed; carries the underlying failure.                                                                                                                                            |
| `managed_slot_registration_refused` | no        | `daemon/registerSession` refused to bind a connection to managed sessions it cannot prove it holds.                                                                                                                       |

Other reconciler codes that can appear in a slot's `failure`: `scope_not_valid`,
`device_busy`, `reconcile_in_progress`, `concurrent_modification`,
`readiness_incomplete`, `provision_failed`, `timeout`, `cancelled`. Each failure
carries `retryable` and a `nextAction`.

## End-to-end example

This is the epic's required scenario, as run live on Android (scope
`host-1` / `runner-A` / `boot-1`, then `boot-2`; runner B in the same host):

1. Runner A starts execution proxy P1 with slot `0` and a device spec.
   AutoMobile creates stable device D for the slot and returns live session S1
   (`disposition: created`, `assignmentGeneration: 1`).
2. P1 closes (stdin EOF). AutoMobile releases S1. D survives, remains assigned
   to A's slot `0`, and has no active session.
3. Runner B's slot `1` cannot acquire or delete D just because D is idle: it
   gets its own device, and `killDevice`, `getAndroid` and `deleteDevice` (with or
   without `force`) on D from B's connection are refused
   (`device_outside_managed_slots`; from a plain client,
   `device_assigned_to_managed_slot`). B's slot `0` is also a different scoped
   identity with its own device.
4. A starts P2 with the same scoped slot `0` and a matching spec. AutoMobile
   reuses D with a fresh session S2, not S1 (`disposition: reused`).
5. A later requests a different spec in slot `0` (`pixel_6` to `pixel_7`).
   AutoMobile deletes D, verifies absence, creates E and records E in the same
   slot before returning a ready session (`disposition: replaced`).
6. A restarts with `runnerIncarnation` `boot-2`. AutoMobile invalidates only A's
   old scope after old owners and cleanup settle; the surviving E is adopted by
   the new slot `0` (`disposition: adopted`). A late proxy still on `boot-1`
   gets outcome `failed` with `scope_invalidated`. B's assignments stay valid.

The failure path was also exercised: a malformed runtime (`"android-36"`) served
MCP in under a second with outcome `failed`, `spec_unsupported`, zero tools,
`managed_slot_acquisition_failed` on every call and no AVD created.

## Native descendants after cancellation and daemon death

This section answers one #12060 research gate: whether request-owned host
processes end, or stay durably fenced, after request cancellation, daemon
SIGTERM and daemon SIGKILL. Retained emulators and simulators are the device,
not unwanted descendants.

Evidence levels: **proven** means
`test/integration/nativeDescendantLifecycle.integration.test.ts` shows it with
real `sleep`/`sh`/`cat`/`bun` processes going through the production spawn helpers. **Faked**
means unit tests with fakes cover it. **Code** means it comes from reading the
source only. No device was used for any of these levels.

| Process (spawn site)                                                                                                                            | Owner                                                             | Request cancel                                                                                                                               | Daemon SIGTERM                                                                                       | Daemon SIGKILL                                                                                            | Durable record / next-start sweep                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One-shot host commands: `xcrun simctl`, `ps`, `pgrep`, `kill`, `plutil` (`DefaultHostCommandExecutor.executeCommand`, `execFile` with `signal`) | request                                                           | SIGTERM to the direct child (**proven**). A forked grandchild keeps running (**proven**).                                                    | No stage; the request abort covers it (**code**)                                                     | Survives until it exits on its own (**code**)                                                             | None. Short-lived.                                                                                                                                                                                |
| One-shot `adb` (`AdbClient` exec)                                                                                                               | request                                                           | SIGTERM, then SIGKILL after a grace when settlement is awaited (**faked**)                                                                   | No stage. `AdbClient.activeProcesses` is never read at shutdown (**code**)                           | Host `adb` survives until it exits (**code**)                                                             | None                                                                                                                                                                                              |
| Long-lived `adb` children: `getevent`, H.264 encoders, ffmpeg-backend `screenrecord` (`AdbClient.spawn`)                                        | request signal by default; `abortSignalScope: "startup"` opts out | SIGTERM to host `adb`. The device-side process relies on adb tearing down the shell (**code**)                                               | Owning servers' stop stages (**code**)                                                               | Host `adb` survives while it does not write to the dead pipe. The device side is unverified.              | None                                                                                                                                                                                              |
| Android file recording `screenrecord` (`PlatformVideoCaptureBackend`)                                                                           | recording, detached from the request after start                  | Startup abort kills it; a failed start cleans up the device pid (**faked**)                                                                  | Recording stop, then force stop, then interrupt, each bounded (`childProcessCleanup.ts`) (**faked**) | Host `adb` and device `screenrecord` survive                                                              | Yes: `capture_teardown_json` (device pid and path). `redriveUnconfirmedCaptureTeardowns` runs at startup (**faked**). The host `adb` pid is not recorded.                                         |
| iOS `simctl io recordVideo` and the live ffmpeg encode (`FfmpegVideoProcessingBackend`)                                                         | recording                                                         | Startup abort SIGKILLs it (**code**)                                                                                                         | Recording stop stages (**code**)                                                                     | Survives; a partial `.mov` remains                                                                        | Recording row only, with no capture descriptor, so there is no process redrive.                                                                                                                   |
| `avdmanager` / `sdkmanager` (`runAndroidCommand`)                                                                                               | request                                                           | SIGTERM, then SIGKILL after `terminationGraceMs` (**proven**, including a TERM-ignoring child)                                               | No stage; the request abort covers it                                                                | Survives (piped stdio)                                                                                    | None. Short-lived.                                                                                                                                                                                |
| Emulator cold boot (`AndroidEmulatorClient` launch)                                                                                             | request until booted, then the retained device                    | `terminateColdBootProcess`: SIGTERM, 1 s, SIGKILL, 1 s, direct pid. SIGTERM is **proven** on a stand-in; the SIGKILL escalation is **faked** | No stage: emulators are retained                                                                     | Survives. The next daemon sees a running emulator.                                                        | No pid record. Booted emulators are intentionally retained.                                                                                                                                       |
| CtrlProxy iOS runner `xcodebuild test-without-building` (`IOSCtrlProxyManager`, `detached: true`)                                               | device                                                            | Not request-owned. Startup retirement group-kills `-pid`.                                                                                    | `IOSCtrlProxyManager.shutdownAll`, then `terminateProcessTree` (group plus descendants) (**faked**)  | Survives, reparented to launchd                                                                           | No record. The command shape is the identity. The startup sweep (`startOrphanRunnerReapOnStartup`) reaps only orphaned (ppid 1) daemon-shaped trees and leaves a parented one alone (**proven**). |
| `iproxy` tunnel (physical iOS) (`IosTunnelClient`)                                                                                              | device                                                            | Not request-owned                                                                                                                            | Instance stop: SIGTERM, then SIGKILL (**faked**)                                                     | Survives                                                                                                  | None. The startup sweep matches `CtrlProxy` runners only, not `iproxy`.                                                                                                                           |
| Simulator screen-capture helper (`IosScreenCaptureHelper`, `detached` on macOS)                                                                 | daemon pool                                                       | Not request-owned                                                                                                                            | `iosSimulatorCaptureHelperPool.shutdown()`: SIGTERM, then group SIGKILL after the grace (**faked**)  | Survives in its own process group. The capture path ignores stdin EOF by design (`ControlChannel.swift`). | None                                                                                                                                                                                              |
| Simulator highlight helper (`SimulatorHighlights`)                                                                                              | daemon, cached per device                                         | The reply wait aborts; the helper stays                                                                                                      | No stage (**code**)                                                                                  | Exits on stdin EOF (`main.swift`, highlight mode). The same EOF shape is **proven** with `cat`.           | None needed                                                                                                                                                                                       |
| `cwebp` / `dwebp` (`WebpBinaryResolver`)                                                                                                        | caller                                                            | Not tied to the request. Bounded: SIGKILL after `WEBP_CODEC_TIMEOUT_MS` (30 s) (**proven**).                                                 | No stage                                                                                             | Finishes on stdin EOF (input truncated if not fully flushed) or dies on SIGPIPE (**code**)                | None. Short-lived.                                                                                                                                                                                |
| Generic long-lived spawn with ignored stdin (the `adb spawn`, `iproxy` and `xcodebuild` stdio shape)                                            | —                                                                 | —                                                                                                                                            | —                                                                                                    | Keeps running after the parent's SIGKILL, reparented to launchd (**proven**)                              | —                                                                                                                                                                                                 |

Boundaries this release does not close (follow-ups):

- Request cancellation of one-shot commands is direct-child-only. A tool that
  forks and does not forward SIGTERM can outlive the request. Whether
  `xcrun` forks `simctl` instead of exec-ing it is unverified.
- After daemon SIGKILL, only two sweeps run: the iOS runner sweep and the Android
  `screenrecord` teardown redrive. There is no sweep for an orphaned `iproxy`,
  the detached simulator capture helper, `simctl io recordVideo`, or host `adb`
  children.
- `AdbClient.spawn` binds long-lived children to the ambient request signal
  unless the caller opts out. They therefore end with the request or session
  that started them, by design or not; each caller must choose.

## Related

- [Device ownership](device-ownership.md): session holds, release rules and reads.
- [Environment variables](environment-variables.md): heartbeat and idle tuning.
- [Managed Macs and CI runners](managed-macs.md).

Startup recovery of slots left `settling` by a dead daemon retries registry reads
and opens at 25 ms doubling to 1 s, then every 1 s until successful or shutdown.
After a blocked failure it also waits at least as long as the attempt took,
capped at 5 s. Concurrent startup recovery calls share one loop. A failed read
never means nothing needed recovery: rehydrated executions remain gated until
ownership is confirmed. Failures log at debug, with one warning after more than
5 s naming the last error. Recovery logs the number of restored slots when
positive and, after any failure, elapsed time and attempt count even for zero
slots. Shutdown cancels the wait quietly and leaves recovery to the next daemon.
The drain's other registry retries keep their existing 250 ms to 5 s schedule,
then every 30 s after the settlement cap.
