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

| Concept                   | Meaning and lifetime                                                                                                                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scoped slot identifier    | A caller-declared numeric `slotIndex`, qualified by `managedHostScope`, `runnerNamespace` and `runnerIncarnation`. Two runners that both use `0` do not share an identity. The registry derives a `scopeKey`, the SHA-256 hex digest of the three scope parts.  |
| Slot-to-device assignment | AutoMobile's host-local mapping from a valid scoped slot to a stable device identifier (AVD name or simulator UDID) and the spec it was resolved against. It survives the execution proxy exiting. Every binding change increments the assignment `generation`. |
| Live session ownership    | The fresh session, held by the current STDIO proxy, that may control the assigned device. AutoMobile owns heartbeat, expiry and cleanup.                                                                                                                        |
| Execution capacity        | The caller's own local concurrency permit. Releasing it does not erase the assignment or free the device for other slots.                                                                                                                                       |

An idle assigned device is not an unassigned device. Ending the live session
clears only the execution owner; the assignment stays, and the device is not
returned to the generic pool. A device assignment is not a session UUID and is
not an externally renewed lease. The resident daemon and the per-execution proxy
keep their usual split: the device and its assignment can outlive the proxy.

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
| `idleTimeoutMs`        | integer 120000-3600000 | Optional. Idle window for the execution's sessions: 2 to 60 minutes. Default is the 2-minute idle window.                                                     |
| `executionOwnerPid`    | positive integer       | Optional. Supervising process whose exit ends the execution even while the proxy's parent lives (for example a wrapper shell). Defaults to the launch parent. |

If `executionOwnerPid` is set, the proxy checks at startup that it names a
running process and otherwise fails with `managed_slot_config_invalid`.

Each entry of `requests`:

| Field             | Type                     | Notes                                                                                                                                                                                  |
| ----------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slotIndex`       | integer >= 0             | Local slot number within the scope.                                                                                                                                                    |
| `role`            | string, 1-256 chars      | Role key for the slot.                                                                                                                                                                 |
| `platform`        | `"android"` or `"ios"`   | Selects the spec schema below.                                                                                                                                                         |
| `requestedSpec`   | object                   | Android: `runtime` (system image id), optional `deviceType`, `displayCutout`, optional `configuration`. iOS: `runtime`, optional `deviceType`, `displayCutout`. Strict: no other keys. |
| `priorDeviceHint` | `{ "stableId": string }` | Optional and non-authoritative: a prior assignment's stable id may be tried first, never trusted.                                                                                      |

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
   the slot's owner. While the session is live, a duplicate proxy still gets
   `slot_in_use` and the scope is never treated as abandoned.
4. **Drain and release.** When the execution ends (stdin EOF, cancellation or
   owner loss) the proxy releases its sessions with a bounded wait
   (`MANAGED_EXECUTION_RELEASE_TIMEOUT_MS`, 1.5 s). The daemon cancels the
   session's in-flight work, waits about 500 ms for it, then releases the session
   (about 700 ms budget). If everything settled, the slot is
   `reusable_for_this_slot`. If work outlived the budget the slot is marked
   `settling` before its owner is cleared, so the next acquisition waits
   (retryable `slot_settling`) until the work ends or the settler is found dead.
   A release clears the execution owner only; the assignment, generation and spec
   are kept, whatever the release reason (explicit, heartbeat loss, idle).
5. **Reuse.** A new proxy with the same scoped slot and a matching spec reuses
   the assigned device with a fresh session. A duplicate proxy for a slot whose
   execution is still live is refused with a retryable `slot_in_use`.

## Idle and liveness

A managed-execution session uses the `managed-execution` liveness policy:

- **Heartbeat.** Same lease as an ordinary heartbeat session: a 4 s lease plus a
  4 s suspect grace, so about 10 s after the last owner heartbeat the session is
  released. Tool calls from other callers do not keep a dead owner alive.
- **Idle.** 2 minutes after the last control call ends, by default. The trusted
  config may set a longer window with `idleTimeoutMs` (2 to 60 minutes); it can
  never shorten it, and there is no exemption from idle. An out-of-range value
  is refused as `managed_slot_config_invalid` rather than clamped. Reads and
  heartbeats never extend the window. The effective window is reported as
  `idleTimeoutMs` in the acquisition result.
- **Idle release is terminal.** As for every session, the session UUID ends with
  the idle release (`session_ownership_lost`; session-not-found answers carry
  `idle: true`). The slot's device stays assigned. To continue, start a new
  execution proxy on the same scoped slot; it reuses the device with a new
  session.
- **Execution owner.** The proxy checks every second that its owner (by default
  the parent process that launched it, or `executionOwnerPid`) is running and,
  for the default owner, that it has not been re-parented. Either loss shuts the
  proxy down and releases its sessions. Stdin EOF ends the execution the same
  way. If the proxy is killed outright, the ~10 s no-heartbeat release applies.
  Limit: with the default owner, a launch parent pid of 1 is treated as already
  orphaned and a parent pid of 0 (for example `docker exec`) as exited. When the
  runner is PID 1 in a container, or the proxy is started by `docker exec`, set
  `executionOwnerPid` to a live pid; an explicit owner takes precedence over the
  parent-pid heuristic.

Values are the defaults in `src/daemon/sessionLivenessWindows.ts`; see
[Device ownership](device-ownership.md#when-a-session-is-released) for the
general release rules.

## Spec matching

Matching is declarative, per slot, and the result reports a `disposition` of
`created`, `reused`, `adopted` or `replaced`:

- **Omitted fields are unconstrained.** An assigned device with any value for an
  omitted field matches. For example "iPhone on iOS 27.0, any model" reuses a
  compatible assigned iPhone whatever its model. A changed creation default
  alone never forces replacement. Resolved values are recorded separately from
  the requested spec (`resolvedSpec`, for example a defaulted `displayCutout`).
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
- Generic `provisionDevice` keeps its existing `identity_conflict` behavior;
  destructive mismatch replacement exists only for managed slots.

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
  incarnation are refused with `scope_invalidated`.
- **Operator command.** Invalidate one incarnation explicitly:

  ```bash
  auto-mobile --daemon reset-slot-scope \
    --runner-namespace runner-A --incarnation boot-1 \
    [--managed-host-scope host-1] [--wait-ms 10000]
  ```

  `--runner-namespace` and `--incarnation` are required; `--managed-host-scope`
  narrows to one host scope; `--wait-ms` is the bounded settle wait (integer 0 to
  60000, default 10000). The command prints the daemon's JSON result and exits
  `0` when every matching scope is invalidated, `2` when a scope is still waiting
  on owners or cleanup (the result lists the live owners, settling and
  cleanup-pending slots and open journal work; retry later), and `1` when no
  scope matched or the call failed. It is idempotent and a repeated call resumes
  where it stopped. It accepts the usual daemon launch options. Like the other
  daemon lifecycle commands, it is refused (`shared_daemon_namespace`) when
  `AUTOMOBILE_DATA_DIR` or the DB dirs are set without
  `AUTOMOBILE_AUX_SOCKET_DIR`, because it would act on the shared resident
  daemon; set the aux socket dir to target a private daemon, or pass
  `--allow-shared-namespace` (or `AUTOMOBILE_ALLOW_SHARED_DAEMON_NAMESPACE=1`)
  deliberately.

- **Abandoned scopes.** A scope with no acquisition and no live owner for one
  hour (`MANAGED_SLOT_ABANDONED_SCOPE_THRESHOLD_MS`) is abandoned, and a daemon
  sweep may then delete its devices. If the **same incarnation** returns, the
  scope is revived (`revived: true` in the result): surviving devices are reused
  and deleted ones recreated. Only an explicit reset or a new incarnation
  invalidates a scope permanently.

Numeric slot `0` can repeat across scopes, but the scoped identity is new each
time.

## Results and failure

On success, the `initialize` result carries the contract under
`capabilities.experimental["automobile/managedSlots"]` and the proxy exposes the
identical JSON as the resource `automobile:managed-slots`
(`MANAGED_SLOTS_RESOURCE_URI`, `application/json`). The payload
(`src/models/managedSlotsResult.ts`):

| Field             | Meaning                                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contractVersion` | `1`.                                                                                                                                                                                                                                                                                                                                                       |
| `scope`           | `managedHostScope`, `runnerNamespace`, `runnerIncarnation`, `scopeKey` (null if it failed before the scope resolved), optional `revived`.                                                                                                                                                                                                                  |
| `outcome`         | `"ready"` or `"failed"`.                                                                                                                                                                                                                                                                                                                                   |
| `idleTimeoutMs`   | The idle window the sessions are held with.                                                                                                                                                                                                                                                                                                                |
| `slots[]`         | Per slot: `slotIndex`, `role`, `platform`, `assignmentGeneration`, `device` (`stableId`, `transportId`, `name`), `sessionUuid`, `requestedSpec`, `resolvedSpec`, `specFingerprint` (`version`, `hash`), `disposition`, `readiness` (`mode`, `status`), `lifecycle` (provision timing and the reconciler's decision trail), and `failure` on a failed slot. |
| `failure`         | Scope- or transport-level failure: `code`, `retryable`, `message`, `nextAction`. Per-slot failures sit on the slot entry.                                                                                                                                                                                                                                  |

If acquisition fails, the proxy still serves MCP: `initialize` reports outcome
`failed` with the typed failure, the tool list is empty, and every tool call is
refused with `managed_slot_acquisition_failed` (the error carries
`acquisitionFailure`; read the resource for the evidence). The launcher must set
its MCP initialize timeout at or above `preparationTimeoutMs`. Launch-config
errors (invalid JSON or schema, `contract_unsupported`, unsupported group size,
dead `executionOwnerPid`) are different: they are raised before the server
starts, and the process exits with the typed code.

Acquisition-level failure codes besides the reconciler's: `contract_unsupported`
(the daemon does not advertise `managed-slots/v1`), `scope_invalidated`,
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
  of `device`, `session` or `tool` (device-acquiring tools are left to slot
  acquisition). Lifecycle tools (`getAndroid`, `getApple`, `startDevice`,
  `provisionDevice`, `killDevice`, `deleteDevice`) are refused with reason `tool`
  even on the connection's own slot device: it could not boot the device again,
  so a stop would strand the execution. End the execution instead; the next
  acquisition on the slot boots and reuses the device.
- The generic device pool skips assigned and free-pool devices as capacity, idle
  or not. If the registry has never been readable, allocation refuses with
  retryable `discovery_incomplete` rather than treat unknown as free.

## Boot capacity

When a platform already runs as many booted devices as its limit allows, a cold
boot is refused at once with the retryable `capacity_exhausted` code instead of
waiting in an internal queue. The error carries `retryAfterMs`, the `limit`, the
`booted` count and `platform`, plus `externalDevices` when counted devices were
not started by AutoMobile. Capacity frees when another device shuts down.
`capacity_exhausted` applies to all boots, including a slot that must create or
boot its device.

## Error codes

| Code                                | Retryable | Meaning                                                                                                                                                                                                 |
| ----------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `managed_slot_config_invalid`       | no        | Config is not valid JSON, fails the strict schema, has duplicate `slotIndex`, an out-of-range `idleTimeoutMs`, a dead `executionOwnerPid`, or is combined with `--initial-session-uuid` / `--no-proxy`. |
| `contract_unsupported`              | no        | `contractVersion` is not supported by this build or daemon.                                                                                                                                             |
| `managed_slot_group_unsupported`    | no        | `localSlotCapacity` or `requests` exceeds one slot and device.                                                                                                                                          |
| `managed_slots_unsupported`         | no        | A config was supplied but this build does not serve managed slots.                                                                                                                                      |
| `spec_unsupported`                  | no        | The requested spec is malformed, or names an Android image, iOS runtime or iOS device type this host has not installed; nothing was changed.                                                            |
| `runtime_incompatible`              | no        | An installed iOS runtime that is unavailable, or outside the requested (or every listed) iPhone model's supported range; nothing was changed.                                                           |
| `slot_in_use`                       | yes       | A live execution already holds the slot.                                                                                                                                                                |
| `slot_settling`                     | yes       | The previous execution's released work is still settling.                                                                                                                                               |
| `stale_session`                     | yes       | An earlier execution's session on the slot device could not be released.                                                                                                                                |
| `scope_invalidated`                 | no        | The request's incarnation was reset and never accepts work again.                                                                                                                                       |
| `scope_transition_pending`          | yes       | A scope reset is waiting for owners or cleanup to settle.                                                                                                                                               |
| `cleanup_pending`                   | yes       | A prior deletion or release has not been confirmed.                                                                                                                                                     |
| `discovery_incomplete`              | yes       | Device inventory or the slot registry was partial, so absence cannot be proven.                                                                                                                         |
| `capacity_exhausted`                | yes       | Boot refused at the platform's booted-device limit.                                                                                                                                                     |
| `device_assigned_to_managed_slot`   | no        | Generic control or lifecycle on a device assigned to a slot (or in the free pool).                                                                                                                      |
| `device_outside_managed_slots`      | no        | A managed connection touched a device, session or tool outside its own slots.                                                                                                                           |
| `managed_slot_acquisition_failed`   | no        | Tool call on a proxy whose acquisition failed; carries the underlying failure.                                                                                                                          |
| `managed_slot_registration_refused` | no        | `daemon/registerSession` refused to bind a connection to managed sessions it cannot prove it holds.                                                                                                     |

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

## Related

- [Device ownership](device-ownership.md): session holds, release rules and reads.
- [Environment variables](environment-variables.md): heartbeat and idle tuning.
- [Managed Macs and CI runners](managed-macs.md).
