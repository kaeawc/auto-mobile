# Session broker experiment: operations and recovery

Part of [the session-only provider experiment](session-broker-experiment.md).

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
profiles (`phone`, `tablet`, or `foldable`) and simulator device types. Without them Android acquisition fails with
`catalog_metadata_invalid`. iPhone Duo requests work whenever the simulator
device type and a compatible runtime are installed, without an opt-in or separate
capability advertisement. Creating a Duo for a
`duo` archetype request needs both a Duo `archetypes` entry and a Duo
`modelTypes` entry. A Duo model-type request needs only the `modelTypes` entry, and
an exact Duo model needs neither.

The optional `defaults.ios.os.archetypes` list holds at most one
entry per archetype, each `{ archetype, selector, preferredVersion }`. An entry replaces `os` for
that hardware archetype only when the request omits the OS. A host can therefore pin phones and
tablets to exact 26.5 while `duo` defaults to 27.1. Explicit request selectors stay as
requested, and provenance records the entry used as `osDefaultArchetype`. Android `os` selectors use the release version (`16`),
not the API level (`36`); at equal versions the resolver prefers `google_apis`
over `google_apis_playstore`.

Android hardware defaults map archetypes to installed
profile IDs through `defaults.android.hardware.profiles`, for example
`[{ "archetype": "foldable", "profileId": "pixel_9_pro_fold", "memoryMb": 4096 }]`
with `androidProfileArchetypes: { "pixel_9_pro_fold": "foldable" }`. The optional
`memoryMb` is an integer of at least 2048 MB and constrains creation and reuse.
The broker refuses unmapped foldables without reservation with non-retryable
`unsupported_hardware`; they never fall back to phone hardware. A request may instead
name one installed profile with `{ "kind": "exact-profile", "profileId": "pixel_9" }`. That profile
must have a class in `androidProfileArchetypes`, and the request reuses only idle devices of that
profile. Foldable baseline
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
- `daemon/sessionRequirementCapability`: `{device}`. Read-only: it reads the
  broker's catalog and defaults and runs the same normalization and resolution
  as admission; it binds no connection, takes no lock and writes no request row.
  A request the host cannot answer fails with the requirement error code
  (`invalid_request`, `invalid_config`, `catalog_unavailable`, …). The MCP tool
  `getSessionRequirementCapability` returns the same answer.

The token plus the complete request configuration define operation identity. After
an ambiguous reply, query the same identity. Replay returns the durable receipt
(including pre-admission refusals when catalog/default resolution fails) and never
allocates a replacement. A concurrent caller cannot replace a committed receipt
with its own failure. If receipt persistence fails the RPC fails without claiming a
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
client connection. RPC aborts do not propagate. `reportReleased` with no remembered
bindings still reports confirmed settlement.

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
  The `cleanupPending: true` value persists while an original prepare runs or durable native
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
transactions for cross-process admission. Assignment generations and native journal
operations stay private, and allocation indices are never public session
identities. Provider-local SQLite only (no Talos PostgreSQL change).

An executed migration unknown to this daemon disables registry exclusion for generic
acquisition. The `files_only` diagnostic names the path, migrations, recorded writer
versions and remedy, and the daemon logs a warning once per process per registry path.
Files-only mode does not enforce managed bindings: this daemon can allocate a device held only by a managed binding,
because allocation claim files alone decide ownership.

Outside files-only mode the
`device_claims` table decides Android and iOS allocation (#11811 step d). A claim is an
optimistic compare-and-set on the device's row: judge a foreign owner's liveness, then
write only if the row, including its `updated_at_ms`, is unchanged. For one more release the
winner also writes its allocation claim file, so a daemon that cannot use the table and falls
back to the files still sees it. A winner whose claim file a files-deciding daemon took meanwhile
gives the row back.

The same compare-and-set records a claim the files decided, and it never
replaces a row a live foreign owner holds. Every local daemon creates and migrates the registry
after its control socket binds. From then on the daemon refuses, retryably, a claim the table cannot decide instead of
falling back to the files (#11811, owner decision E1). That covers no registry open yet, and a
write still busy after four attempts 50, 100 and 200 ms apart. The claim files decide before
bind (startup recovery), for watch and TV, and in files-only mode.

The device-claims mirror skips
reads, writes, opens and retries until daemon restart. Writers and ownership readers
requiring current registry evidence still fail with non-retryable
`registry_schema_unsupported`. Its payload includes recorded writer versions, and the
schema guard runs before any migration or write. Migration provenance records only
migrations the current upgrade executed; earlier migrations remain unknown.
In broker mode, `daemon/capabilities` describes the schema and its compatibility on
an already-open registry connection without opening or migrating a registry.

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
granted session before the model starts; they are not part of the acquisition request.

## Upgrading from the retired device-slot system

There is no slot launch configuration, reset command, slot MCP capability/resource, or
slot-only acquisition/refusal protocol. On the first daemon start after upgrade, migration 008 retires legacy slot assignments, journals and free-pool
records before device discovery and session recovery. It stops legacy product
devices through the ordinary shutdown path, confirms native state, then removes the
records (AVD/simulator images stay). Live owners, broker overlap, incomplete
inventory or an unconfirmed stop leave retirement pending for a later startup (a
broker provider fails startup; an ordinary daemon warns and continues). The
verification pass is bounded to 30 s.

Broker records and their private scope
survive; registry locations, SQL storage names and migration keys stay compatible.
An older daemon never upgrades or modifies unknown executed migrations.
Files-only mode does not enforce managed bindings.
Upgrade the daemons sharing managed devices to a release that includes these migrations.
The retained native-resource budget variable is documented under
[environment variables](../using/environment-variables.md).
