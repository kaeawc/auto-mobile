# Session-only provider experiment

A caller requests a device, receives a fresh execution session UUID, uses it, and
releases it. Callers never select slots, pool identities, runner scopes, or
capacity. Requirement vocabulary and default resolution:
[session-requirements.md](session-requirements.md). Reuse/reset/capacity tuning:
[Session broker device reuse, reset, and capacity](session-broker-device-reuse.md).

The experiment is opt-in: set `AUTOMOBILE_SESSION_BROKER_CONFIG` to the absolute
path of an operator JSON configuration when starting the provider daemon. An
already-running ordinary daemon does not become a broker because a client
requests the new contract.

## Timing receipts and statistics

`contractVersion: 1` replies gain an optional `timing` object (consumers ignore
unknown fields; `session-request-status --json` preserves it unprojected).
`timing.acquisition` is stored on the request receipt; release replies include it
plus `timing.reset`. A `cleanup_pending` reply's reset record is updated after
cleanup, so read request status for the final record. Legacy receipts,
pre-admission refusals, and a `cleanup_pending` reply whose budget expired before
timing existed may omit timing.

**Acquisition record**: `admission` (`reuse`, `create`, `evict-then-create`,
`wait`; `wait` only on failed/pending records), `outcome` (`pending`, `ready`,
`failed`), `reuseCount`, `startedAtMs`, optional `completedAtMs`, and phases
`queueMs` (always 0: no admission queue), `admissionWaitMs` (catalog/default
resolution plus the reservation transaction), `createMs` (includes exact-device
discovery/provisioning), `bootMs`, `automationReadyMs`, `totalMs`. Native phases
come from the provision timing tree (`provisionExactDevice`, `bootDevice`);
unmeasured phases are omitted, never zero. Reuse reports zero create/boot.
`reuseCount` starts at 0 and increments once per reuse reservation, even if
preparation later fails.

**Reset record**: `mode` (`keep-booted`, `erase`, `snapshot`, `wipe-data`,
`none`), `outcome` (`clean`, `fallback:<mode>`, `destroyed`, `pending`), `phases`
(name to ms), optional `fallbackReason`, `reuseCount`, timestamps, `totalMs`.
`drain` and `reset` are broker phases; platform resetters add native phases (iOS
erase: `stop`, `erase`, `boot`, with partial evidence on failure). The
`ResetOutcome` port record is `{ outcome, mode, phases, fallbackReason? }`; legacy
`"clean"`/`"pending"` returns stay accepted (unknown mode is `none`).
`fallback:<mode>` means a clean fallback completed and is reuse-eligible, not just
attempted; `none` is not a fallback mode. Failed resets keep the reason and end as
`destroyed` after authoritative cleanup.

**`daemon/sessionBrokerStats { windowMs?, limit? }`** (read-only): window default
24 h / max 30 d; sample cap default 5000 / max 10000. Returns `sinceMs`, `untilMs`,
`limit`, `truncated`, and `groups` per exact platform/profile with
acquisition/reset counts, `reuseHitRate`, `fallbackRate`, `retirements`, and
per-phase `{ count, p50, p90 }` ms (linear-interpolation percentiles; rates are
fractions, empty denominators give 0). Only completed records in the window count;
acquisition counts, percentiles and hit rates use only `ready` acquisitions;
unknown phases are excluded. It reads the newest updated receipts up to the cap and
reports truncation: these are sampled receipts, not lifetime counters.
`retirements` = destroyed reset records plus idle-trim retirements marked
`retired` (including destruction still pending), not admission evictions or
failed-acquisition destruction. Timing and the saved profile survive provider
restart and are pruned with receipts under `RECEIPT_RETENTION_MS` (export pins
retain their behavior). Structured log lines carry the same records and profile
without owner tokens, scope keys or allocation indices.

## Pinned session exports

Broker mode advertises `session-broker-export/v1`. A client may pass strict
`export: { prepareId, requestDigest }` (1-256 chars each) to
`daemon/prepareSession`. Admission and pre-admission failures link the identity to
the request receipt in the same transaction, before native work. Replays may link
a previously unexported receipt; conflicting identities/digests fail with
`session_export_identity_mismatch`.

- `daemon/getSessionExport { prepareId, requestDigest, livenessOwnerToken }`
  returns `{ contractVersion: 1, prepareId, requestDigest, acknowledged, result }`
  or `session_export_not_found`. The result derives from the current durable
  receipt (after owner-exit recovery: `failed` / `session_owner_exited` with the
  original session UUID and profile). Auth uses the original consumer token even if
  recovery changed the daemon owner. Reading grants no session control and never
  acquires a replacement.
- `daemon/acknowledgeSessionExport` (same params) returns
  `{ prepareId, outcome: "acknowledged" | "unknown_export" }`. Digest and owner
  checks precede acknowledgement; exact replays keep the first acknowledgement time.
- An unacknowledged export pins its receipt past the 30-day terminal window, up to
  a configurable 180-day export age. Acknowledged/expired rows prune with their
  eligible receipts (pending resource cleanup and tombstone guards still apply).
  Clients omitting `export` keep the existing prepare contract.

## Shutdown refusals and retry cadence

Once restart handoff begins, new prepare and abandon calls return an RPC refusal:
`success: false`, `code: "session_broker_stopping"`, `retryable: true`,
`retryAfterMs: 5000`. Retry the same identity against the successor daemon; the
refusal neither admits a request nor stores a receipt. Already-admitted
preparations interrupted by shutdown store a terminal `session_broker_stopping`
receipt with `retryable: true`, `retryAfterMs: 5000`,
`retryRequires: "new_request_id"` (even while cleanup is pending); first reply and
replays carry identical guidance.

`session_restart_handoff_pending` and configured-but-unavailable refusals use the
same hint, matching the service's five-second recovery interval. It is a pacing
hint, not a readiness deadline. Stopping/handoff-pending refusals log at debug;
non-retryable owner and export identity mismatches warn. A failed initial handoff
snapshot warns and still joins preparations; close retries the snapshot after the
join. A failed second snapshot rejects close so the service keeps its host lock.

## Reuse and reset boundary

Default is zero pooling: every relinquished device is destroyed through the
durable native journal, with authoritative absence required before capacity is
freed.

- **iOS**: clean reuse is an experimental opt-in (`reuseCleanDevices`, iOS only).
  Reset drains the execution, stops via the ordinary lifecycle handler, erases, and
  boots the same simulator. Fresh inventory must confirm exact type, runtime,
  availability and expected state; durable ownership and native-binding checks
  fence every mutation. Any failure falls back to journaled destruction.
- **Android**: separate `reuseAndroidCleanDevices` (default false). With Android
  defaults, `androidResetMode` is `keep-booted` (best-effort cleaning) or
  `snapshot` (baseline restoration).
- Without a mutation-aware strategy, any package-list difference requires
  destruction, never uninstall-and-pool. Baseline capture failure warns without
  failing acquisition; release then destroys. Baselines and activity subscriptions
  are scoped to the broker resource, not its recyclable adb serial.
- The native activity guard is conservative: the execution-end event does not
  identify the tool, so any admitted non-read session use (including package
  install) disables minimal reset; read-only sessions cannot reuse either since adb
  and Gradle activity are unobservable. `AndroidResetStrategy` stays injectable
  (#14364, #14365) with optional fenced capture and retirement hooks; strategies
  fence native work via `assertOwned`. Target/boot/package-manager/CtrlProxy checks
  are safeguards, not isolation proof, and fake-strategy tests are not evidence of
  native isolation.

### Android keep-booted

Selected by `androidResetMode: "keep-booted"` only with `reuseAndroidCleanDevices`
and Android defaults (ignored reset keys are rejected by config validation).
`androidKeepBootedMaxUses` (positive int, default 20) retires to the baseline
strategy or destruction at that count. Counts are resource-local. Restart loses
the in-memory reset receipt; a persisted baseline without it marks the incarnation
retired (next release must destroy; no counter reset or fallback re-entry to idle).
The journal incarnation is the broker resource ID plus stable native device
identity and kernel boot UUID (not the per-release binding generation), so a
recycled serial or reboot cannot transfer a baseline. Binding generations still
fence reset ownership.

Owner decision (#14358 / #14364): "i actually don't care about readback and having
evidence, i just want to run whatever cleaning operations". Keep-booted is
operational cleanup; no baseline diff or post-clean certification is required, and
certification metadata never blocks it.

**Baseline** (persists across sessions of the incarnation): package membership for
all packages and users; identities and runtime grants for third-party apps only
(avoids a per-system-package `dumpsys` sweep); global (once) and system/secure
(per user) settings dumps; display overrides; locale; timezone; SHA-256 digest of
the account inventory (never raw names); file inventories under `/sdcard/Download`,
`DCIM`, `Pictures`, `Movies`, `Documents`.

**Every release**: journal reverts in reverse order, then unconditional baseline
cleaning (so journal ops cannot reintroduce drift):

- `pm list users`; `pm uninstall --user` every third-party package absent from that
  user's baseline.
- Keep baseline app data and fixtures; never `pm clear` by default. Revoke runtime
  grants not in the baseline for retained third-party apps per user; never run
  device-wide `pm reset-permissions`.
- Restore changed/missing global/system/secure keys. Delete an added key only when
  the session journal proves the session created it (a raw `ns:key` row with an
  absent prior, or a key owned by a journaled rotation, screen-reader or keep-awake
  tool). Keys absent from the baseline without that evidence, such as
  system-maintained ringtone, alarm and `opa_enabled` settings, are preserved
  (settings commands target the captured user, including 0). Non-critical failures warn and
  continue; connectivity, adb/developer, or accessibility restoration failure is
  hard.
- Remove added regular files under the inventoried roots with canonical-path and
  symlink guards; preserve baseline paths even if contents changed.
- Clear the clipboard when supported (unsupported warns and skips; a failed
  supported clear is hard).

Unplannable journal entries warn and skip rather than veto reuse; journal replay
never removes baseline packages. Every command is ownership-fenced, cancellable,
bounded, non-retrying: 2 s each, 10 s for uninstall, up to 30 s for baseline file
hashing, all within the enclosing 30 s cleaning/capture cap. Afterward boot
completion, package-manager responsiveness and a single CtrlProxy probe (2 s) are
checked. Timeout/cancel aborts cleaning and waits up to 2 s for settlement; an
exhausted drain never starts snapshot fallback. Success reports `mode:
"keep-booted"`, `outcome: "clean"` with `journal`, `clean`, `health` phases.

**Failure/fallback**: hard failure or failed health uses the injected snapshot
fallback if configured, otherwise journaled destruction; ownership loss never
publishes idle or runs fallback under a stale fence. `maxUses` retires the same
way. Fallback health must pass before idle; the report uses the completed
fallback's mode (`snapshot`/`wipe-data`) and keeps both the cleaning/retirement
reason and the snapshot's fallback reason. `androidKeepBootedFallback:
"snapshot"` injects it (omitted/`"destroy"` keeps destruction); it and
`androidKeepBootedMaxUses` are valid only in keep-booted mode. Snapshot support
needs the daemon readiness and identity ports; missing ports reject startup.

Snapshot fallback uses an exclusive binding fence, not the old boot UUID (restore
can change it). After successful restore (or wipe-data replacement) exact
target/boot checks rebind the incarnation, prune prior mutation journals and
recapture a keep-booted baseline under the new boot identity; recapture or final
health failure requires destruction. Fallback native phases carry a `snapshot:`
prefix alongside the keep-booted phases.

**Limits**: does not remove accounts/secrets, reset retained app databases/data,
undo system package updates, rebuild overwritten/deleted baseline files,
comprehensively restore AppOps/permission flags, remove users, or clean
secondary-user shared storage/media-provider state. Residual state is accepted when
commands and health checks succeed; it is not equivalent to snapshot/wipe-data
isolation.

**Journal prior-value shapes** for supported targeted reverts:

| Kind                     | Key / prior                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `installed-app`          | package key, absent prior (force-stop then uninstall); needs explicit `user:<id>:<package>` key, never every user   |
| `permission`             | `runtime:<user>:<pkg>:<perm>` boolean, or `appops:<user>:<pkg>:<op>` mode (absent = default)                        |
| settings                 | `global\|secure\|system:<key>` string or absent, `settings put`/`delete`; connectivity/DND use the platform service |
| display / clock          | `display:density\|size\|night-mode`; `timezone` via alarm service                                                   |
| `shared-file`            | absent-prior `/sdcard` file; path guards, media-scan request; existing contents cannot be rebuilt                   |
| `preference`             | app-data clearing skipped (preserves fixtures)                                                                      |
| `location` / `clipboard` | absent-prior `provider:gps\|network\|fused` / empty prior                                                           |

Not qualified as revert adapters: system locale, system package update rollback,
account removal, notification cancellation, existing app/file data, network
shaping. No tool instrumentation is silently enabled (the journal's
pending-adapter ledger applies). The strategy retains journal entries through
health checks and settlement; fenced retirement pruning deletes incarnation
baselines and their session entries. Capture is capped at the cleaning budget
(30 s) within the remaining preparation budget. The snapshot fallback uses
`androidResetTimeoutMs`, limited to the time remaining, with 2001 ms reserved for
the command-settlement drain; it receives `signal`, `timeoutMs`, `deadlineMs` in
the shared reset context.

### Android snapshot reset and fallback

`androidResetMode: "snapshot"` selects the full-baseline strategy directly (also
requires Android defaults and `reuseAndroidCleanDevices: true`).

```json
{
  "reuseAndroidCleanDevices": true,
  "androidResetMode": "keep-booted",
  "androidKeepBootedFallback": "snapshot",
  "androidKeepBootedMaxUses": 20,
  "androidResetTimeoutMs": 600000
}
```

`androidResetTimeoutMs` is a positive integer ms (max 2147483647), accepted only
for snapshot mode or keep-booted with snapshot fallback (ignored keys rejected).
Default 600000 covers the whole release reset: cleaning, fallback, rebinding,
final health. Keep-booted keeps its 30 s cap; the fallback gets a fresh
cancellable budget bounded by the remaining deadline minus the settlement reserve;
individual snapshot commands keep a 30 s cap; clock root and transport reconnection
keep their own bounded timeouts.

Snapshot mode captures the reserved, hidden broker baseline only on a freshly
created or replaced emulator (keep-booted snapshot fallback captures it during
initial preparation, not after cleaning fails). AVD, image revision/hardware,
emulator and CtrlProxy identity must match before load. Restore goes through
incarnation preparation, host-state invalidation, exact-serial readiness and
settlement before health is accepted. A failed/incompatible load attempts a
capacity-reserved same-AVD, same-serial wipe-data replacement. Shutdown must prove
the emulator process exited (not merely vanished from adb) and remove dirty
`default_boot` state; relaunch preserves `AUTOMOBILE_EMULATOR_ARGS`, appends
wipe/no-snapshot flags and releases the launch cancellation handle before
readiness. Failed snapshot plus wipe-data requires journaled destruction.

Snapshot clean-reuse isolation remains unqualified until native two-session
contamination checks pass (fake-backed tests qualify composition and fencing only).

## Native qualification summary (October 2026)

| Check                                       | Result                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| iOS zero pooling (iPhone 17 Pro / iOS 26.5) | passed: distinct UUIDs/UDIDs; acquire ~45-59 s, release ~16 s; second request got `capacity_exhausted` with no tools; replay of the refusal stayed terminal (`retryRequires: "new_request_id"`)                                                              |
| iOS clean-reuse contamination               | passed for files, app/global prefs, keychain item, Contacts grant, app removal; old connection got `broker_session_ended`. Reuse acquire 12-17 s, reset 50-152 s: no throughput benefit shown                                                                |
| iOS interrupted-reset recovery              | passed: daemon killed mid-`resetting`; restart destroyed the uncertain simulator, original request stayed `failed`/`session_owner_exited` incl. on replay                                                                                                    |
| iOS mixed-profile replacement               | passed: phone, tablet, phone with caps of 1; journal showed confirmed destruction before next create intent (gaps ~0.9 s)                                                                                                                                    |
| Android zero pooling (API 35 arm64)         | passed: coarse phone/tablet resolved to `medium_phone`/`medium_tablet`; AVD absent after release; serial `emulator-5556` reused across sessions (the transport serial is not a session identity). Does not cover Android clean reuse, ADB restart, Linux/KVM |
| Request abandonment (iOS)                   | passed: unknown, `acquiring`, and ready requests all reached terminal owner-bound receipts with exact native absence confirmed; late native claims are covered by deterministic tests                                                                        |

The measured clean reset spent ~15 s stopping, 0.3 s erasing, 52 s booting: reset
isolates by rebooting an erased simulator, so an idle-pool hit moves boot work to
the preceding release rather than avoiding it. Keep zero pooling as the throughput
baseline until a matched comparison shows a benefit. Not run: native Android
two-session contamination and matched p50 timing. A Slack bundle that failed
simulator install with a copy-permission error installed from a staged copy with
readable directories and no xattrs/ACLs (contents identical); the disposable probe
uses simulator entitlement metadata rather than restricted entitlements in its ad
hoc host signature.

## Operator configuration

```json
{
  "contractVersion": 1,
  "limits": { "totalDeviceCap": 2, "sessionCap": 2, "idlePoolCap": 0 },
  "defaults": {
    "ios": {
      "platform": "ios",
      "policyVersion": "local-ios-26.5-v1",
      "hardware": {
        "omitted": "phone",
        "archetypes": [
          { "archetype": "phone", "modelType": { "family": "iphone", "variant": "pro" } }
        ],
        "modelTypes": [
          {
            "modelType": { "family": "iphone", "variant": "pro" },
            "model": { "namespace": "product-model", "value": "iPhone18,1" }
          }
        ]
      },
      "os": { "selector": { "kind": "exact", "version": "26.5" }, "preferredVersion": "26.5" }
    }
  },
  "reuseCleanDevices": false,
  "reuseAndroidCleanDevices": false
}
```

`androidProfileArchetypes` and `iosClassifications` classify installed AVD
profiles (`phone`, `tablet`, or `foldable`) and simulator device types; without them Android acquisition fails with
`catalog_metadata_invalid`. `capabilities.iosDuo` (default `false`, requires
`defaults.ios`) lets the host execute iPhone Duo requests. Creating a Duo for a
`duo` archetype request needs both a Duo `archetypes` entry and a Duo
`modelTypes` entry; a Duo model-type request needs only the `modelTypes` entry;
an exact Duo model needs neither. Android `os` selectors use the release version (`16`),
not the API level (`36`); at equal versions the resolver prefers `google_apis`
over `google_apis_playstore`. Android hardware defaults map archetypes to installed
profile IDs through `defaults.android.hardware.profiles`, for example
`[{ "archetype": "foldable", "profileId": "pixel_9_pro_fold", "memoryMb": 4096 }]`
with `androidProfileArchetypes: { "pixel_9_pro_fold": "foldable" }`. The optional
`memoryMb` is an integer of at least 2048 MB and constrains creation and reuse.
Unmapped foldables are refused without reservation with non-retryable
`unsupported_hardware`; they never fall back to phone hardware. Foldable baseline
reset restores opened posture and a 180-degree hinge before final health checks.

**Caps** are optional nonnegative integers. Reservations, native creation, active
sessions, reset, uncertain state, and unfinished destruction count toward the total
cap; failed acquisition with unfinished native work keeps session capacity. A full
pool must confirm eviction before reserving a replacement (no burst). Selection
prefers the most recently returned compatible device (even after a cap reduction)
and evicts the least recently returned idle device otherwise. A pending eviction or
transient destroy failure returns `eviction_pending` (`retryable: true`,
`retryAfterMs: 1000`, `retryRequires: "new_request_id"`); its destroying resource
keeps capacity reserved and the failed ID stays terminal. Permanent destroy errors
are non-retryable `session_preparation_failed`. Managed provisioning's
`cleanup_pending` is separate: retryability is suppressed while that request's
cleanup is pending, with no delay injected.

**iOS reset boots**: erase resets reserve their boot slot before shutdown and hold
it through erase and boot. Optional `limits.maxConcurrentResetBoots` bounds
concurrent iOS resets (excess releases wait in the cleanup queue; omitted shares
the boot gate's host limit). Android reset is unchanged.

**Reset wait**: admission may wait once for a compatible resetting iOS resource when
profile timing history estimates it finishes within the p50 create-plus-boot time.
Missing or overdue estimates keep ordinary create/evict/refuse. Idle completion
and reset failure wake waiters to reconsider transactionally; waiters never own
the resetting resource. Timeout falls back to ordinary admission (caps still
apply) and the wait is subtracted from the preparation budget; cancellation and
deadline expiry start no replacement.

`listDevices.capacity.ios.admissionsByReason` reports live `reset`, `create`,
`restart` admissions (including reset reservations while shut down). Counts can
overlap booted inventory and are not extra slots; boot-duration history keeps the
same reason tag.

## Consumer contract

Start the normal MCP proxy with `--session-config <json-or-path>` or
`AUTOMOBILE_SESSION_CONFIG` (mutually exclusive with a preselected session UUID and
direct/no-proxy mode).

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

The proxy probes `session-broker/v1`, prepares the request, and publishes the flat
result under MCP initialize capability `experimental["automobile/session"]` (no
resource API). A ready result carries the session UUID and resolved device
profile. Pending or failed preparation exposes no device tools and never falls
back to generic acquisition. The keeper maintains liveness; EOF and
execution-owner exit cancel preparation or relinquish the session.

Daemon protocol:

- `daemon/prepareSession`: `{config, livenessOwnerToken}`.
- `daemon/sessionRequestStatus`: `{requestId, livenessOwnerToken}`.
- `daemon/abandonSessionRequest`: `{requestId, livenessOwnerToken}`.
- `daemon/releaseBrokerSession`: `{sessionId, livenessOwnerToken, reason?,
  replyBudgetMs?}`. A client release omits `reason` and ends `released` only after
  cleanup settles; the reply waits at most 30,000 ms after `beginRelease` commits
  durable `releasing`/`resetting` ownership, else returns `cleanup_pending`
  (#13798). A proxy whose execution owner died sends `reason:
  "session_owner_exited"`: the daemon commits the terminal
  `failed`/`session_owner_exited` receipt, answers `cleanup_pending`, and finishes
  drain and destruction as tracked release work (#12791).
- Reconnect registration: `{sessionId, clientName, sessionBroker: {requestId,
  livenessOwnerToken}}`.

The token plus the complete request configuration define operation identity. After
an ambiguous reply, query the same identity. Replay returns the durable receipt
(including pre-admission refusals when catalog/default resolution fails) and never
allocates a replacement; a concurrent caller cannot replace a committed receipt
with its own failure; if receipt persistence fails the RPC fails without claiming a
terminal result. A new execution attempt needs a new request ID.

**Release reply budget** (`SESSION_BROKER_RELEASE_REPLY_BUDGET_MS`, via broker
options with an injected `Timer`): 30 s default, well inside the CLI's 240 s
transport timeout. Per-call `replyBudgetMs` is clamped to [0, 30000] (non-finite
and null ignored). Each proxy attempt requests its remaining budget minus 500 ms
(250 ms minimum). Database commitment is required before the budget starts; a
failed commitment rejects without acknowledging ownership.

An expired budget does not cancel native work: the same tracked release continues
through drain, reset or destruction, and the final receipt read; concurrent and
later release calls share it with bounded waits. Startup recovers durable receipts
before socket bind and starts native cleanup in the background afterward (#13948).
Recovery cleanup slots await full tracked releases (keeping abort signals and the
concurrency limit) and never use the RPC reply budget; `joinReleases()` and daemon
shutdown join the full operation. Early failures reject; failures after a pending
reply are warned and the tracking entry removed on settlement.

`cleanup_pending` acknowledges durable release ownership; it is not proof of native
absence or a terminal `released` receipt. The CLI returns it without retrying and
proxy teardown drops its heartbeat hold without waiting. Consumers needing
completion poll the original request receipt or retry release for the same session
UUID (no duplicate cleanup). Recovery owns unfinished cleanup independent of the
client connection. RPC abort propagation is separate future work (a request signal
could stop only the caller's bounded wait). `reportReleased` with no remembered
bindings still reports confirmed settlement; changing that needs separate
binding-ownership and recovery tests.

### Provider CLI (harness lifecycle commands, not model tools)

```text
auto-mobile --daemon capabilities --json
auto-mobile --daemon session-request-status <request-id> --liveness-owner-token <token> --json
auto-mobile --daemon abandon-session-request <request-id> --liveness-owner-token <token> --json
auto-mobile --daemon release-broker-session <session-uuid> --liveness-owner-token <token> --json
auto-mobile --daemon session-info <session-uuid> --json
```

- `capabilities` returns the daemon's complete `daemon/capabilities` result
  unchanged; release readiness requires `session-broker/v1` in `capabilities`. A
  missing/unreachable daemon, RPC refusal, or malformed result exits nonzero with
  one JSON failure object. It never starts a daemon, registers an MCP server, reads
  inventory, or acquires a session. The capability RPC identifies contracts, not
  the process: use `auto-mobile --daemon status --json` as the identity authority
  (PID, version, build ID, entry script, socket, recovery state).
- All commands contact only the existing daemon. Success of the command does not
  mean acquisition succeeded; status preserves terminal failures and pending
  cleanup as reported.
- Abandonment consumes the original identity (even one the daemon has not seen) and
  returns its terminal failed receipt; late preparation cannot allocate from it.
  `cleanupPending: true` persists while an original prepare runs or durable native
  cleanup remains; `false` means no local prepare remains and the journal confirmed
  native absence. Abandon and release have a 240 s request budget. Release returns
  `released`, `cleanup_pending`, or `unknown_session` (not cleanup proof; query the
  original receipt after an ambiguous release).
- `session-info` supplies the bound native device as descriptive metadata only.

## Native device identity

New native devices are named `ambroker-<scope>-<idx>-g<gen>-<nonce>`; ownership
also recognizes legacy `amslot-` for upgrade compatibility. Both are charged to the
native resource budget and excluded from the normal pool, including interrupted
creations without registry rows. Scoped interrupted creations stay adoptable by
their original binding, and persisted assignments use the same release, cache
eviction and journaled destruction paths across upgrades. A product name alone
never authorizes deletion. Inventory reports `runtime.heldBy: "session_broker"`.

## Ownership and recovery

One host registry and one native journal authority. The broker adds durable request
receipts and admission reservations to the same SQLite database, using immediate
transactions for cross-process admission; assignment generations and native journal
operations stay private, and allocation indices are never public session
identities. Provider-local SQLite only (no Talos PostgreSQL change).

Broker mode holds a process-generation-aware host lock and refuses startup over
unaccounted managed inventory or live generic sessions (drain the prior provider
first). It disables legacy allocation/reset requests and competing abandoned-scope
or free-pool reclaimers; native journal recovery starts after the ownership checks.
Generic or nested tool calls cannot acquire a device or operate without a live
broker-granted session.

Interrupted requests retain durable cleanup ownership; recovery never promotes an
interrupted device to a clean pool entry, and one request's failure does not
starve later cleanup. Shutdown cancels and joins broker work before closing the
registry; recovery waits are interruptible. Graceful shutdown does not release
granted sessions: it durably marks each active one handed off and the restarted
provider adopts the same UUID once rehydration re-owns its native binding. A
handed-off session that did not survive, and every session of a crashed provider,
ends `session_owner_exited` with its device destroyed. A forcibly terminated
process can leave native work pending, so restart qualification must exercise the
durable journal.

App installation and initial configuration are deterministic operations on the
granted session before the model starts and need no Slack application SDK.
Folding them into the acquisition request is a later ergonomic change.

## Upgrading from the retired device-slot system

The declarative launch configuration, reset command, MCP capability/resource, and
slot-only acquisition/refusal protocol are removed. On the first daemon start after
upgrade, migration 008 retires legacy slot assignments, journals and free-pool
records before device discovery and session recovery: it stops legacy product
devices through the ordinary shutdown path, confirms native state, then removes the
records (AVD/simulator images stay). Live owners, broker overlap, incomplete
inventory or an unconfirmed stop leave retirement pending for a later startup (a
broker provider fails startup; an ordinary daemon warns and continues). The
verification pass is bounded to 30 s. Broker records and their private scope
survive; registry locations, SQL storage names and migration keys stay compatible.
The retained native-resource budget variable is documented under
[environment variables](../using/environment-variables.md).
