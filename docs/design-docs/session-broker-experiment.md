# Session-only provider experiment

This local experiment adds a provider contract in which a caller requests a
device, receives a fresh execution session UUID, uses that session, and releases
it. Callers do not select slots, pool identities, runner scopes, or capacity.
The requirement vocabulary and default resolution are documented in
[session-requirements.md](session-requirements.md).

## Timing receipts and statistics

`contractVersion: 1` replies gain an optional `timing` object. Existing consumers
may ignore it and any future fields. `session-request-status --json` preserves
it without projection. `timing.acquisition` is stored on the request receipt;
release replies include it plus `timing.reset`. A `cleanup_pending` reply's
reset record is updated after cleanup; read request status to obtain the final
record. If the release reply budget expires before timing is available, that
`cleanup_pending` reply can omit timing. Legacy receipts and pre-admission
refusals can also omit timing.

Acquisition records expose `admission` (`reuse`, `create`, `evict-then-create`,
`wait`); `wait` appears only on failed or pending records because successful
acquisitions record the admission selected after the reset wait. They also expose
`outcome` (`pending`, `ready`, `failed`), `reuseCount`, `startedAtMs`, optional
`completedAtMs`, and millisecond phases `queueMs`, `admissionWaitMs`, `createMs`,
`bootMs`, `automationReadyMs`, `totalMs`. This broker has no admission queue, so
`queueMs` is zero. `admissionWaitMs` includes catalog/default resolution and the
reservation transaction. Native creation and boot phases come from the existing
provision timing tree (`provisionExactDevice` and `bootDevice`); the creation
phase includes exact-device discovery/provisioning, not only the create command.
Unmeasured native phases are omitted, never manufactured as zero. Reuse reports
zero creation and boot phases. `reuseCount` starts at zero and increments once
per reuse reservation, including a reservation whose preparation later fails.

Reset records expose `mode` (`keep-booted`, `erase`, `snapshot`, `wipe-data`,
`none`), `outcome` (`clean`, `fallback:<mode>`, `destroyed`, `pending`),
`phases` (phase names mapped to milliseconds), optional `fallbackReason`,
`reuseCount`, timestamps and `totalMs`. `drain` and `reset` measure broker
operations; platform resetters add native phases. iOS erase returns `stop`,
`erase`, `boot`, including partial phase evidence on failure. The extensible
`ResetOutcome` port record carries `{ outcome, mode, phases, fallbackReason? }`;
legacy `"clean"`/`"pending"` returns remain accepted (unknown mode is `none`).
`fallback:<mode>` means a clean fallback completed and is eligible for reuse,
not merely that fallback was attempted; `none` is not a fallback mode. Failed resets retain the reason and
ultimately report `destroyed` after authoritative cleanup.

`daemon/sessionBrokerStats { windowMs?, limit? }` is a read-only daemon method:
default window 24 hours, maximum 30 days; default sample cap 5000, maximum 10000.
It returns `sinceMs`, `untilMs`, `limit`, `truncated`, and `groups` per exact
platform/profile, with acquisition/reset counts, `reuseHitRate`, `fallbackRate`,
`retirements`, and per-phase `{ count, p50, p90 }` in milliseconds. Percentiles
use the repository's linear-interpolation convention. Rates are fractions;
empty denominators yield zero. Only completed records in the requested time
window contribute; acquisition counts, percentiles and reuse hit rates include
only successful (`ready`) acquisitions. Failed acquisitions remain in receipts
but do not contribute to these statistics. Unknown phases are excluded rather than counted as zero.
The indexed read considers the newest updated receipts, is bounded by the
sample cap, and reports truncation explicitly. Statistics are sampled receipts,
not lifetime resource counters. `retirements` counts destroyed reset records and
idle-trim retirements marked `retired`, including destruction still pending,
not admission evictions or failed-acquisition device destruction. Timing and the saved profile survive provider
restart, including resource tombstone deletion, and are pruned with receipts
under `RECEIPT_RETENTION_MS` (export pins retain their usual behavior).
Structured acquisition/reset log lines contain the same records and profile,
without owner tokens, scope keys or allocation indices. Pending reset attempts
and their eventual terminal update may each emit a line.

## Pinned session exports

Broker mode advertises `session-broker-export/v1`. A client may pass the strict
optional `export: { prepareId, requestDigest }` to `daemon/prepareSession`; both
strings must contain 1–256 characters. Admission and pre-admission failures link
this identity to the request receipt in the same transaction, before native work.
Replays may link a previously unexported receipt; conflicting prepare identities
or digests are rejected with `session_export_identity_mismatch`.

`daemon/getSessionExport { prepareId, requestDigest, livenessOwnerToken }` returns
`{ contractVersion: 1, prepareId, requestDigest, acknowledged, result }`, or
`session_export_not_found`. The result derives from the current durable receipt:
after owner-exit recovery it reports `failed` / `session_owner_exited`, retaining
the original session UUID and profile. Authentication uses the original consumer
token even when recovery changes the daemon owner. Reading an export grants no
session control and never acquires a replacement device.

`daemon/acknowledgeSessionExport` takes the same strict parameters and returns
`{ prepareId, outcome: "acknowledged" }`, or `"unknown_export"` for an absent
identity. Digest and owner checks precede acknowledgement; exact replays preserve
the first acknowledgement time. An unacknowledged export pins its receipt past
the normal 30-day terminal window, up to a configurable 180-day export age.
Acknowledged or expired export rows prune with their eligible request receipts;
pending resource cleanup and retained-receipt tombstone guards still apply.
Clients omitting `export` retain the existing prepare contract.

## Shutdown refusals and retry cadence

Once restart handoff begins, new prepare and abandon calls return an RPC refusal:
`success: false`, `code: "session_broker_stopping"`, `error: "Session broker is stopping"`,
`retryable: true`, and `retryAfterMs: 5000`. Retry the same request identity against the
successor daemon; the stopping refusal neither admits a request nor stores a terminal
receipt. It stays outside preparation's `failureFor` mapping. Already-running
preparations cancelled by shutdown retain the existing `session_preparation_failed`
terminal receipt and cleanup behavior.

Retryable `session_restart_handoff_pending` and configured-but-unavailable broker
refusals use the same hint, shared with the service's five-second idle interval between
recovery passes. This is a pacing hint, not a readiness deadline: recovery work can
extend a pass. Stopping and handoff-pending refusals log at debug; non-retryable request
owner and export identity mismatches remain warnings. A failed initial handoff snapshot
warns and still joins preparations; close retries the snapshot after that join before
finishing releases. A failed second snapshot still rejects close so the service keeps
its host lock.

## Current qualification boundary

For choosing a reuse mode, configuring resets and sizing caps, see
[Session broker device reuse, reset, and capacity](session-broker-device-reuse.md).

The first native milestone deliberately uses zero pooling. Every relinquished
device is destroyed through the existing durable native journal, with
authoritative absence required before its capacity is freed. Native iOS clean
reuse is an experimental opt-in. Its reset
drains the execution, stops the device through the ordinary lifecycle handler,
erases it, and boots that same simulator. Fresh inventory must confirm the exact
type, runtime, availability, and expected state; durable ownership and native
binding checks fence every mutation. Any failure falls back to journaled
destruction. `reuseCleanDevices` continues to opt in only to iOS reuse. Android
has its own `reuseAndroidCleanDevices` flag, defaulting to false. With Android
defaults, `androidResetMode` selects either `keep-booted` best-effort cleaning
or `snapshot` baseline restoration before returning the resource to idle.
Keep-booted cleaning is operational cleanup, not proof of isolation or
restoration of all device state. It can opt into snapshot fallback; by default
hard failures require destruction.
Without a mutation-aware strategy, any observed package-list difference requires
destruction, never uninstall-and-pool. Optional baseline capture failure
logs a warning without failing acquisition; release then destroys the device.
Baselines and activity subscriptions are scoped to the broker resource, not its
recyclable adb serial.

The native activity guard is deliberately conservative: the existing execution
end event does not identify the tool, so any admitted non-read session use
(including package-install tools) disables minimal reset. Read-only sessions can
not reuse either, since adb and Gradle activity are unobservable. The narrow
`AndroidResetStrategy` hook remains injectable for qualified implementations in
#14364 and #14365, with optional fenced capture and resource-retirement hooks.
Strategies fence native work using `assertOwned`; target, boot,
package-manager and CtrlProxy checks are safeguards, not isolation proof.
Fake strategy tests are not evidence of native isolation. The keep-booted mode
does not require a complete baseline diff or post-cleaning state certification.

### Android keep-booted adapter boundary

The optional operator field `androidResetMode: "keep-booted"` selects the journal
strategy only when `reuseAndroidCleanDevices` and Android defaults are also
configured; ignored reset keys are rejected by configuration validation.
Omitting the mode preserves destruction-only behavior. The
`androidResetMode` enum contains both `keep-booted` and `snapshot`. Optional
`androidKeepBootedMaxUses` is a positive integer (default 20); reaching that count
retires to a configured baseline strategy or destruction, not keep-booted idle.
Counts are resource-local and disappear on destruction. Restart loses the
in-memory reset receipt. A persisted baseline without that receipt marks the
incarnation retired: its next release requires destruction and cannot reset the
counter or use a fallback to re-enter idle.
Production journal incarnation contains the broker resource ID, stable native
device identity and kernel boot UUID, not the per-release binding generation.
A recycled emulator serial or reboot cannot transfer the original baseline to
a replaced incarnation. Binding generations still fence reset ownership.

Owner decision for #14358 / #14364:

> i actually don't care about readback and having evidence, i just want to run whatever cleaning operations

The Android port captures package membership for all installed packages and users,
but captures package identities and runtime grants only for third-party apps to
avoid a per-system-package `dumpsys` sweep. It also captures global/system/secure
settings dumps (global once; system/secure per user),
display overrides, locale, timezone, an account-inventory SHA-256 digest (never
raw account names), and file inventories under `/sdcard/Download`, `DCIM`,
`Pictures`, `Movies`, and `Documents`. The pool-entry baseline persists across
sessions of that incarnation. Certification metadata describes observation
limits but never blocks Android keep-booted cleaning.

On every release, journal reverts run in reverse order, followed by unconditional
baseline cleaning so journal operations cannot reintroduce baseline drift:

- Enumerate every current user with `pm list users` and uninstall each third-party
  package absent from that user's pool-entry baseline using `pm uninstall --user`.
- Keep baseline app data and preinstalled test fixtures. Never run `pm clear` by
  default, including known-empty app-data journal entries. Revoke currently granted
  runtime permissions that were not granted at baseline, for retained third-party
  apps in each user. Do not run device-wide `pm reset-permissions` or revoke baseline
  grants.
- Restore changed or missing global/system/secure keys; delete added keys. A failed
  non-critical settings put/delete warns and continues. A failed connectivity,
  adb/developer, or accessibility setting restoration is a hard failure.
- Remove added regular files under the inventoried `/sdcard` roots with existing
  canonical-path/symlink guards; preserve baseline paths even if contents changed.
- Clear the clipboard when the platform supports it. Unsupported capability output
  warns and skips; failures of a supported clear are hard failures.

Unplannable journal entries warn and skip rather than vetoing reuse. Failed
non-critical journal settings restoration also warns and continues. Every command
is ownership-fenced, cancellable, bounded and non-retrying. Boot completion,
package-manager responsiveness and CtrlProxy reachability are checked after
cleaning; the CtrlProxy probe gets one attempt with an explicit signal and a
two-second deadline. Commands have a two-second budget except package uninstall,
which gets ten seconds, and baseline file hashing, which gets up to 30 seconds;
all remain inside the enclosing 30-second cleaning/capture cap. Timeout or
cancellation aborts cleaning and waits up to two more seconds for settlement
before fallback or failure; an exhausted drain never starts snapshot fallback.
Journal replay preserves baseline packages even if an entry says its prior was
absent. Settings put/delete explicitly target the captured user, including user 0.
Successful release reports `mode: "keep-booted"`, `outcome: "clean"`,
and `journal`, `clean`, and `health` phase timings before broker idle settlement.
No post-cleaning baseline equality/readback certification is required.

Hard cleaning failures or failed health checks use an injected snapshot-compatible
fallback if configured, otherwise journaled destruction. Ownership loss never
publishes idle or runs a fallback under a stale fence. `maxUses` still retires via
fallback or destruction. Fallback health checks must also pass before idle; its
report uses the completed fallback's mode (`snapshot` or `wipe-data`) and retains
both the cleaning/retirement reason and the snapshot strategy's fallback reason. Set
`androidKeepBootedFallback: "snapshot"` to inject the snapshot strategy in
production; omitted or `"destroy"` leaves the existing destruction fallback.
This field and `androidKeepBootedMaxUses` are valid only in keep-booted mode.
Snapshot support requires the daemon readiness and identity ports; missing
ports reject startup rather than silently changing the requested policy.

Snapshot fallback uses an exclusive binding fence, not the old kernel boot UUID,
because restore can change that UUID. After successful restore (or the snapshot
strategy's wipe-data replacement), exact target/boot checks rebind the incarnation,
prune the previous mutation journals and recapture a keep-booted baseline under
the new boot identity. The next session reuses that baseline without resetting
it to potentially dirty state. Binding ownership remains fenced throughout;
recapture or final health failure requires destruction, never idle. Native phase
timings from the fallback carry a `snapshot:` prefix on both success and failure
in the keep-booted receipt, alongside the keep-booted journal/clean/fallback phases.

**Limits:** this policy does not remove accounts/account secrets, reset retained
app databases or other app data, undo system package updates, rebuild overwritten
or deleted baseline files, comprehensively restore AppOps/permission flags, remove
users, or clean arbitrary/secondary-user shared storage and media-provider state.
It intentionally accepts residual state when cleaning commands and health checks
succeed. Keep-booted is not equivalent to snapshot restore or wipe-data isolation.

Journal prior-value shapes for supported targeted reverts are:

- `installed-app`: package key, absent prior (force-stop then uninstall).
- `permission`: `runtime:<user>:<package>:<permission>` with a boolean prior, or
  `appops:<user>:<package>:<operation>` with a mode prior (absent means default).
  `pm reset-permissions` is device-wide, not package-scoped; do not use it to
  restore unrelated retained-package permissions.
- Settings: `global|secure|system:<key>` with a string or absent prior, restored
  with `settings put` or `settings delete`. Supported connectivity/DND settings
  use the corresponding platform service rather than merely changing the key.
- Display: `display:density`, `display:size` and `display:night-mode`; clock:
  `timezone` via the platform alarm service.
- `shared-file`: an absent-prior `/sdcard` file, with canonical-path/symlink guards
  before removal and a media-scan request. Existing file contents cannot be rebuilt.
- `preference`: app-data clearing is skipped to preserve fixtures;
  `location`: absent-prior `provider:gps|network|fused`; `clipboard`: empty prior.

System locale restoration, system package update rollback, account removal,
notification cancellation, existing app/file data and network shaping are not
qualified revert adapters. Unplannable entries are skipped and logged.
Package removals require explicit `user:<id>:<package>` mutation keys; unscoped
package keys are not revertible. Force-stop and uninstall commands
target that explicit user, never every user.
No tool instrumentation is silently enabled; the journal's pending-adapter ledger
still applies. Every native command is fenced, cancellable, bounded and non-retrying.
Replay and baseline cleaning do not require certification. The strategy retains
journal entries through health checks and broker settlement; fenced retirement
pruning deletes incarnation baselines and all associated session entries on
retirement. Preparation captures the partial native baseline regardless of
certification coverage. Capture is capped at the cleaning budget (30 seconds by
default) within the remaining preparation budget; file hashing commands have a
30-second cap, still subject to the enclosing capture/reset deadline.
The injected snapshot fallback uses `androidResetTimeoutMs` (600000 ms by default),
limited to the time actually remaining when fallback starts, with 2001 ms reserved
for its bounded command-settlement drain before the overall deadline. It receives
`signal`, `timeoutMs` and `deadlineMs` in the shared reset context; the composed
snapshot strategy uses cancellable, fenced native commands.

### Android snapshot reset and fallback

`androidResetMode: "snapshot"` selects the full-baseline strategy directly.
It requires Android defaults and `reuseAndroidCleanDevices: true`, as does
keep-booted mode. Omitting the mode preserves destruction-only behavior.

```json
{
  "reuseAndroidCleanDevices": true,
  "androidResetMode": "keep-booted",
  "androidKeepBootedFallback": "snapshot",
  "androidKeepBootedMaxUses": 20,
  "androidResetTimeoutMs": 600000
}
```

This fragment supplements a valid host configuration with Android defaults.
`androidResetTimeoutMs` is an optional positive integer in milliseconds no
greater than 2147483647. It is accepted only for snapshot mode or keep-booted
with snapshot fallback; ignored timeout keys are rejected. Its default is
600000 (ten minutes), covering the whole release reset including cleaning,
fallback, incarnation rebinding and final health checks. Keep-booted cleaning
retains its own 30-second cap; the fallback gets a fresh cancellable budget
bounded by the remaining overall reset deadline minus the settlement reserve.
Individual snapshot commands
retain their 30-second cap; clock root and transport reconnection retain their
own bounded timeouts within the remaining overall budget.

Snapshot mode captures the reserved, hidden broker baseline only on a freshly
created or replaced emulator. Keep-booted snapshot fallback captures that same
baseline during initial preparation, not after dirty cleaning fails. AVD,
image revision/hardware, emulator and CtrlProxy identity must match before load.
Restore goes through incarnation preparation, host-state invalidation,
exact-serial readiness and settlement before health is accepted. A failed or
incompatible load attempts a capacity-reserved same-AVD, same-serial wipe-data
replacement. Shutdown must prove the emulator process has exited, not merely
disappeared from adb, and remove dirty `default_boot` state. Relaunch preserves
`AUTOMOBILE_EMULATOR_ARGS`, appends wipe/no-snapshot flags and releases the launch
cancellation handle before readiness. A failed snapshot and wipe-data fallback
requires normal journaled destruction, never idle or out-of-band child signals.

Snapshot clean-reuse isolation remains unqualified until native two-session
contamination checks pass. Fake-backed tests qualify composition and fencing,
not native isolation; keep-booted retains its intentional best-effort boundary.
Native two-session contamination and matched p50 timing qualification are not run.

Native zero-pooling qualification passed on October 12, 2026, using broker
commit `6fb70c201` on this macOS host with iPhone 17 Pro / iOS 26.5:

- Two distinct fresh execution UUIDs and simulator UDIDs were acquired and
  relinquished. Acquisition took approximately 59 and 45 seconds; each confirmed
  release took approximately 16 seconds.
- The first session successfully observed its device through the normal MCP
  proxy. Observation of the second session was not part of this smoke test.
- While the first session was active, a second request received
  `capacity_exhausted` and advertised no tools.
- Replaying that refused identity after capacity was freed returned the same
  terminal refusal (`retryable: true`, `retryRequires: "new_request_id"`: only a
  fresh request ID can observe the freed capacity). A new request identity acquired the next fresh session.
- Both releases reached terminal receipts with no pending cleanup. The native
  run completed at `2026-10-12T20:40:54Z`; artifacts are retained locally under
  `session-broker-native/smoke-2026-10-12T20-38-35.228Z`.

The preceding combined deterministic and file-backed suite passed 392 tests.
It included independent-process capacity and replay contention, durable cleanup
after reopen, stale-session admission, launcher recovery, and joined shutdown.
This is a provider lifecycle milestone, not yet a Slack test batch or Talos
orchestration qualification.

Native iOS clean-reuse contamination qualification passed on October 12, using
commit `5b42f19fa`, build `d87070dbdd844943`, and iPhone 17 Pro / iOS 26.5:

- A and B received different session UUIDs on the same simulator UDID.
- A installed Slack and a disposable probe app. It wrote a container file,
  app and global preferences, a generic keychain item, and a Contacts grant.
  Before B's setup, Slack and the old container were absent. Reinstalling the
  same probe identity in B found no keychain item, preference, or file, and
  Contacts authorization was undetermined.
- A's old tool connection returned `broker_session_ended`; B could still
  observe afterward. Final release left one clean idle resource, no execution
  claim, and zero active sessions/executions.
- Reused acquisition took approximately 12 and 17 seconds. Reset/release took
  approximately 152 and 50 seconds. These observations do not establish a
  throughput benefit over zero pooling; phase timings now separate stop, erase,
  and boot for subsequent qualification.
- Evidence is retained under
  `session-broker-native/reuse-2026-10-12T21-17-16.536Z`. This covers the exercised
  contamination classes, not every OS service or app behavior.

Native interrupted-reset recovery passed with commit `2ce453401`, build
`ac7a587ccf2ec269`, on the same host and profile:

- The test terminated the exact experiment daemon after fresh native inventory
  showed the owned simulator shut down and the durable resource still
  `resetting`. It verified the daemon's process generation before termination.
- Restart through the ordinary launcher recovered the unfinished reset by
  destroying the uncertain simulator. Native inventory confirmed absence.
  The original request remained failed with `session_owner_exited` and no
  pending cleanup, including on exact replay.
- A subsequent request received a new session and simulator, successfully
  observed it, and remained usable after a delayed release of the old session.
  The successor's explicit release completed.
- Evidence is retained under
  `session-broker-native/recovery-2026-10-12T21-25-07.792Z`. This exercises one
  specific crash boundary; it does not establish every possible interruption.

The successor's measured clean reset spent approximately 15 seconds stopping,
0.3 seconds erasing, and 52 seconds booting. This reset establishes isolation by
rebooting an erased simulator; an idle-pool hit therefore moves boot work to the
preceding release rather than avoiding it. Retain zero pooling as the initial
throughput baseline until a matched comparison demonstrates a reuse benefit.

Native iOS mixed-profile replacement passed on the same build:

- Phone → tablet → phone acquired the requested iPhone 17 Pro and iPad Pro
  11-inch M4 profiles on iOS 26.5. All three sessions observed successfully and
  completed their clean-idle release. Replacement used fresh execution and
  native device identities.
- The total and session caps were both one. Read-only registry observations
  never counted more than one non-destroyed resource. Separately, the durable
  native journal recorded confirmed destruction before the next create intent,
  with gaps of 935 and 946 milliseconds in the two replacements. End-state
  native inventory also confirmed the old UDIDs absent.
- Final state was one clean idle phone, no execution claim, and zero active
  sessions/executions. The three executions, including reset, took about seven
  minutes; they were provider checks without app setup or model execution.
- Evidence is retained under
  `session-broker-native/profiles-2026-10-12T21-28-16.377Z`, including
  `journal-ordering.json`. Sampling alone is not proof of every transient
  instant; the journal ordering and native absence checks supply the separate
  replacement evidence.

Native Android zero-pooling qualification passed on the same build using the
already-installed JDK 21 and Android 15/API 35 Google APIs arm64 image:

- Coarse phone and tablet requirements resolved to `medium_phone` and
  `medium_tablet`, respectively. Both booted and observed successfully.
- A concurrent tablet request while the phone was active received
  `capacity_exhausted` and no tools. Exact replay after capacity was freed
  retained that refusal.
- Each release joined its terminal receipt. Parsed AVD inventory confirmed
  that the exact AVD no longer existed, and fresh ADB inventory omitted its
  former serial. Final state contained no non-destroyed broker resources and
  no active sessions/executions; all three MCP clients closed.
- Successive sessions had different session/resource/AVD identities while
  Android reused `emulator-5556`. This is expected: the transport serial is not
  a session identity.
- Evidence is retained under
  `session-broker-native/android-2026-10-12T21-40-00.576Z`. A preceding attempt
  stopped before acquisition because the qualification script checked a
  nonexistent status field; correcting that check required no provider change.
  These checks qualify local arm64 phone/tablet lifecycle, not Android clean
  reuse, application behavior, ADB restart recovery, or Linux/KVM deployment.

Native request-abandonment qualification passed on October 13 with commit
`e7ca3bfd0441`, bundle build `90cce1d8b41ca9a3`, and the same iOS profile:

- Abandoning an unknown request committed a terminal owner-bound receipt.
  A later exact prepare returned that receipt without allocating.
- Abandoning an observed `acquiring` request cancelled and joined preparation.
  Its durable resource reached `destroyed` and status reported no pending
  cleanup. No simulator identifier materialized in this exercised race.
- Abandoning a ready MCP session preserved its UUID in the terminal receipt.
  Raw `simctl` inventory confirmed its exact simulator was absent, and its old
  tool connection returned `broker_session_ended` without generic acquisition.
- A fresh successor received different session and simulator identities,
  observed successfully, and completed ordinary release. Raw inventory
  confirmed its absence; all 19 retained resource records were `destroyed`.
- Evidence is retained under
  `session-broker-native/abandon-2026-10-13T10-43-36.827Z`. An earlier probe
  incorrectly required an older preparation reply to reflect later cleanup;
  the final check distinguishes that immutable reply from current status.
  This native race covers early acquisition; deterministic tests separately
  cover late native claims and cleanup remaining pending.

The supplied Slack bundle initially failed simulator installation with a
copy-permission error. A staged copy with readable directories and no extended
attributes or ACLs installed successfully; all 516 regular files were compared
and had identical contents. The original was preserved. The disposable probe
uses simulator entitlement metadata, rather than restricted entitlements in
its ad hoc host code signature.

The experiment is opt-in. Set `AUTOMOBILE_SESSION_BROKER_CONFIG` to the absolute
path of an operator JSON configuration when starting the provider daemon.
An already-running ordinary daemon does not become a broker because a client
requests the new contract.

Example operator configuration for a host with the corresponding installed
CoreSimulator device type and runtime:

```json
{
  "contractVersion": 1,
  "limits": {
    "totalDeviceCap": 2,
    "sessionCap": 2,
    "idlePoolCap": 0
  },
  "defaults": {
    "ios": {
      "platform": "ios",
      "policyVersion": "local-ios-26.5-v1",
      "hardware": {
        "omitted": "phone",
        "archetypes": [
          {
            "archetype": "phone",
            "modelType": { "family": "iphone", "variant": "pro" }
          }
        ],
        "modelTypes": [
          {
            "modelType": { "family": "iphone", "variant": "pro" },
            "model": { "namespace": "product-model", "value": "iPhone18,1" }
          }
        ]
      },
      "os": {
        "selector": { "kind": "exact", "version": "26.5" },
        "preferredVersion": "26.5"
      }
    }
  },
  "reuseCleanDevices": false,
  "reuseAndroidCleanDevices": false
}
```

`androidProfileArchetypes` and `iosClassifications` classify installed AVD
profiles and simulator device types; without them Android acquisition fails
with `catalog_metadata_invalid`. Android `os` selectors use the release version
(for example `16`), not the API level (`36`); with equal versions the resolver
prefers the `google_apis` flavor over `google_apis_playstore`.

Caps are optional, nonnegative integers. Reservations, native creation, active
sessions, reset, uncertain state, and unfinished destruction count toward the
total cap. Failed acquisition with unfinished native work retains session
capacity too. A full pool must confirm eviction before reserving a replacement;
there is no temporary burst. Pool selection prefers the most recently returned
compatible device, even after a total-cap reduction, and evicts the least recently
returned idle device when no compatible idle device is available. A pending
eviction or transient destroy failure returns `eviction_pending` with
`retryable: true`, `retryAfterMs: 1000`, and `retryRequires: "new_request_id"`.
Its destroying resource keeps capacity reserved for recovery. The failed request
ID remains terminal; after cleanup frees capacity, retry with a new request ID.
Permanent destroy errors remain non-retryable `session_preparation_failed` failures.
Managed provisioning's `cleanup_pending` remains a separate failure: its retryability
is suppressed while that request's resource cleanup is pending, with no retry delay injected.

For iOS clean pooling, erase resets reserve their existing boot slot before shutdown
and hold it through erase and boot. Optional `limits.maxConcurrentResetBoots` is a
positive integer bounding concurrent iOS resets; excess releases wait in the broker
cleanup queue before reserving a boot slot. If omitted, resets share the boot gate's
host limit. This does not change Android reset behavior.

Admission can wait once for a compatible resetting iOS resource when successful
profile timing history estimates it will finish within the p50 create-plus-boot
time. Missing or overdue estimates preserve ordinary create/evict/refuse behavior.
Idle completion and reset failure wake waiters to reconsider admission transactionally;
waiters never own the resetting resource. Timeout falls back to ordinary admission,
still respecting device and session caps, and subtracts the wait from the preparation
budget. Cancellation and deadline expiry do not start a replacement acquisition.

`listDevices.capacity.ios.admissionsByReason` reports live `reset`, `create`, and
`restart` admissions, including reset reservations while their simulator is shut
down. These counts can overlap the booted inventory and are not additional slots.
Boot-duration history retains the same reason tag and supports per-reason queries.

## Consumer contract

Start the normal MCP proxy with `--session-config <json-or-path>` or
`AUTOMOBILE_SESSION_CONFIG`. It is mutually exclusive with a preselected session UUID and direct/no-proxy mode.

```json
{
  "contractVersion": 1,
  "requestId": "a-new-unique-id-for-this-execution-attempt",
  "device": {
    "schemaVersion": 1,
    "platform": "ios",
    "hardware": { "kind": "archetype", "archetype": "phone" },
    "os": { "kind": "omitted" }
  },
  "idleTimeoutMs": 3600000
}
```

The proxy probes `session-broker/v1`, prepares the request, and publishes its
flat result under MCP initialize capability
`experimental["automobile/session"]`. No resource API is added. A ready result
contains the granted session UUID and resolved device profile. Pending or failed
preparation exposes no device tools and never falls back to generic acquisition.
The existing keeper maintains liveness; EOF and execution-owner exit cancel
preparation or relinquish the granted session.

The daemon protocol is:

- `daemon/prepareSession`: `{config, livenessOwnerToken}`.
- `daemon/sessionRequestStatus`: `{requestId, livenessOwnerToken}`.
- `daemon/abandonSessionRequest`: `{requestId, livenessOwnerToken}`.
- `daemon/releaseBrokerSession`: `{sessionId, livenessOwnerToken, reason?, replyBudgetMs?}`.
  A client release omits `reason` and ends `released` only after cleanup settles.
  Its reply waits at most 30,000 ms by default after `beginRelease` commits durable
  `releasing`/`resetting` ownership; slower cleanup returns `cleanup_pending`
  (#13798). A proxy whose execution
  owner died sends `reason: "session_owner_exited"`: the daemon commits the
  terminal `failed`/`session_owner_exited` receipt, answers `cleanup_pending`,
  and finishes the drain and device destruction as tracked release work (#12791).
- Reconnect registration: `{sessionId, clientName, sessionBroker:
  {requestId, livenessOwnerToken}}`.

The token and complete request configuration define operation identity.
After an ambiguous reply, query the same identity. Replaying a request returns
its durable receipt, including refusals before admission when catalog or default
resolution fails; it never allocates a replacement session. A concurrent caller
cannot replace a previously committed receipt with its own preparation failure.
If receipt persistence fails, the RPC fails without claiming a terminal result.
A new execution attempt needs a new request ID.
Release reports either confirmed release or cleanup still pending. The reply
budget is `SESSION_BROKER_RELEASE_REPLY_BUDGET_MS`, configurable through broker
options with an injected `Timer`. The 30-second default gives native destruction
time to return an honest `released`, well within the CLI's 240-second transport
timeout. An optional per-call `replyBudgetMs` is clamped to [0, 30,000]; non-finite
numbers and null are ignored. On each attempt the proxy requests its remaining
budget minus 500 ms (with a 250 ms minimum), so retries request shorter waits and
the daemon has time to answer before the proxy's own timeout.
Database commitment is required before the reply budget starts; a failed
commitment still rejects without acknowledging release ownership.

An expired reply budget does not cancel or detach native work: the same tracked
release continues through drain, baseline reset or destruction, and the final
receipt read. Concurrent and later release calls share that work, each with a
bounded wait. Startup recovers durable receipts before socket bind and starts native
cleanup in the background afterward (#13948). Recovery cleanup slots await full
tracked releases, preserving their abort signals and concurrency limit even when a
pass stops waiting; they never use the RPC reply budget. `joinReleases()` and daemon
shutdown join the full operation, never just the reply. Early failures still reject; failures after
a pending reply are warned and the tracking entry is removed on settlement.
Existing native-error recovery and durable cleanup ownership remain unchanged.

`cleanup_pending` is acknowledgment of durable release ownership, not proof of
native absence or a terminal `released` receipt. The CLI returns it without
retrying, and proxy teardown drops its heartbeat hold without waiting for native
cleanup. Consumers needing completion poll the original request receipt or retry
release for the same session UUID; retries do not start duplicate cleanup. A later
recovery pass owns unfinished durable cleanup independently of the client
connection. Owner-exit release keeps its existing terminal-failure semantics and
prompt reply.

RPC abort propagation is separate work: a request signal could stop only the
bounded caller wait after commitment, while the shared native operation must keep
running for other callers and shutdown. The current `reportReleased` result with
no remembered bindings still reports confirmed settlement. Changing that evidence
contract requires separate binding-ownership and recovery tests; this reply-budget
change does not alter it.

Deterministic consumers can use the provider CLI instead of implementing its
socket protocol:

```text
auto-mobile --daemon capabilities --json
auto-mobile --daemon session-request-status <request-id> --liveness-owner-token <token> --json
auto-mobile --daemon abandon-session-request <request-id> --liveness-owner-token <token> --json
auto-mobile --daemon release-broker-session <session-uuid> --liveness-owner-token <token> --json
auto-mobile --daemon session-info <session-uuid> --json
```

The capabilities command contacts the existing daemon and returns its complete
`daemon/capabilities` result unchanged. Release readiness requires
`session-broker/v1` in its `capabilities` array. A missing or unreachable daemon,
an RPC refusal, or a malformed result exits nonzero and prints one JSON failure
object; the command never starts a daemon, registers an MCP server, reads device
inventory, or acquires a session. The current capability RPC identifies
contracts, not the daemon process. Check `auto-mobile --daemon status --json`
separately when the worker must verify the daemon PID, version, build ID, entry
script, socket, or recovery state. If a future capability result includes
identity fields, this command will preserve them, but the status check remains
the identity authority.

These commands only contact the existing daemon. Status preserves terminal
failures and pending cleanup as reported; successful command execution does not
mean acquisition succeeded. Abandonment consumes the original request identity,
including one the daemon has not seen yet, and returns its terminal failed receipt;
late preparation cannot allocate from that identity. Its receipt keeps
`cleanupPending: true` while an original prepare is still running or durable native
cleanup remains. `cleanupPending: false` therefore means no local prepare remains
and the assignment/journal has confirmed native absence. Abandonment and release
have a 240-second request budget. Release returns
`released`, `cleanup_pending`, or `unknown_session`. An unknown session is not
cleanup proof. Query the original request receipt after an ambiguous release.
Session info supplies the currently bound native device as descriptive metadata;
it is not a device-selection operation. These are harness lifecycle commands,
not model tools.

## Native device identity

New native devices use `ambroker-<scope>-<idx>-g<gen>-<nonce>` names. Product
ownership also recognizes the legacy `amslot-` prefix for upgrade compatibility.
Both remain charged to the native resource budget and excluded from the normal
pool, including interrupted creations without registry rows. Scoped interrupted
creations remain adoptable by their original binding; persisted assignments use
the same release, cache eviction and journaled destruction paths across upgrades.
A product name alone never authorizes deletion. Inventory reports
`runtime.heldBy: "session_broker"` for broker devices.

## Ownership and recovery

There is one host registry and one native journal authority. The broker adds
durable request receipts and admission reservations to that same SQLite
database, using its immediate transactions for cross-process admission. Existing
assignment generations and native journal operations remain private implementation
details. Allocation indices are not recycled as public session identities.
This changes provider-local SQLite only; it requires no Talos PostgreSQL change.

Broker mode holds a process-generation-aware host lock and refuses startup over
unaccounted managed inventory or live generic sessions. Drain the prior provider
before opting in. It disables legacy allocation/reset requests and competing
abandoned-scope/free-pool reclaimers. Native journal recovery starts only after
the ownership checks. Generic or nested tool calls cannot acquire a device or
operate without a live broker-granted session.

Interrupted requests retain durable cleanup ownership. Recovery never promotes
an interrupted device to a clean pool entry, and failure of one request does not
starve later cleanup. Shutdown cancels and joins broker work before closing its
registry; recovery-loop waits are interruptible. A graceful shutdown does not
release granted sessions: it durably marks each active one as handed off, and the
restarted provider adopts the same session UUID once rehydration has re-owned its
native binding. A handed-off session that did not survive the restart, and every
session of a crashed provider, ends as `session_owner_exited` with its device
destroyed. A forcibly terminated process
can leave native work pending, so restart qualification must exercise the durable
journal rather than assume graceful shutdown always completes.

Application installation and initial configuration are deterministic operations
on the granted session, before the model starts. They do not require a Slack
application SDK. Combining them into the acquisition request remains a later
ergonomic change; the lifecycle boundary already encloses the entire execution.

## Upgrading from the retired device-slot system

The declarative launch configuration, reset command, MCP capability and resource,
and slot-only acquisition/refusal protocol have been removed. Use the consumer
session request and provider host configuration described above.

On the first daemon start after upgrade, migration 008 retires legacy slot
assignments, journals and free-pool records before normal device discovery and
session recovery. It uses the ordinary platform shutdown path to stop legacy
product devices, confirms their native state, then removes the legacy records.
AVD and simulator images remain on disk. Live owners, broker overlap, incomplete
inventory or an unconfirmed stop leave retirement pending for a later startup;
a broker provider fails startup, while an ordinary daemon warns and continues.
The verification pass is bounded to 30 seconds.

Broker records and their private scope survive. Existing registry locations,
SQL storage names and migration keys remain compatible. New device names use
`ambroker-`; inventory also recognizes legacy `amslot-` names. Ownership results
now report `heldBy: "session_broker"`. The retained native-resource budget
variable is documented under [environment variables](../using/environment-variables.md).
