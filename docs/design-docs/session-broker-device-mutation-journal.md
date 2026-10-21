# Device mutation journal and baseline reset contract

## Delivery boundary

This is the contract/persistence/planning slice of #14359 under #14358. It does
not enable keep-booted pool reuse. The iOS (#14361) and Android (#14364) lanes
must supply qualified platform adapters and wire acquisition, tool execution,
reset and fallback into the broker. No production tool has been silently marked
journaled: `DEVICE_MUTATION_TOOL_COVERAGE` explicitly lists pending adapters and
their reasons. Its registry enumeration test includes mixed, hidden and SDK
tools, and rejects a new control tool without an explicit justification.

Acceptance criteria 2 (production record-before-act) and 3 (journal-backed
release/read-through) remain unmet. No production caller writes this journal or
invokes reset yet; #14359 must not close as fully delivered on this slice. The
allowlist distinguishes `pending-adapter` device/composite/lifecycle operations
from `notJournaled` host-only exemptions. Neither status proves journaling or
enforces record-before-act in production.

## Identity and persistence

`SqliteBindingRegistry.deviceMutationJournal()` shares the existing host registry
SQLite connection. Migration `2026_10_21_012_device_mutation_journal` adds
`device_mutation_journal` and `device_mutation_baselines` to that store's static
migration set, not to the per-daemon database migration folder.

Callers supply the exact `(sessionUuid, deviceId, incarnation)` identity. The
incarnation must be a durable native resource generation/identity that survives
daemon restarts and changes whenever the device is replaced. A process-local
incarnation counter or reusable serial alone is insufficient. The baseline is
shared across sessions of the same device incarnation, never across replacements.

`record` commits before the device action; `applyJournaledMutation` enforces that
ordering and does not invoke the action if persistence fails. First write per
`(scope, kind, key)` wins. `appliedAt` timestamps the mutation intent, not a
successful device acknowledgement. SQLite's sequence provides deterministic
reverse ordering even when timestamps coincide or the wall clock moves.
Failed/ambiguous mutations retain their intent so recovery can safely retry.

The prior value is a tagged JSON value: `{ state: "absent" }` is distinct from
both JSON null and the literal string `"absent"`. Unknown kinds remain durable
and force a non-revertible plan; schema evolution must not discard them.

## Platform port obligations

`DeviceMutationResetPort.canRevert` qualifies the specific kind, key and prior
payload, not just the kind name. `revert` must set the original absolute state,
tolerate already-absent resources, and produce the same result on repeat replay.
Compound prior values can carry app-group identities or legacy restore metadata.
The adapter must preserve ordering required by its platform inside each step.
An adapter may translate each step to an apply/verify/revert profile (#14067);
the contract deliberately contains no platform commands.

Every device I/O dispatch must await `context.assertOwned()` immediately before
acting and honor `context.signal`, including after queued or delayed awaits.
The reset runner checks ownership before each phase/step and after verification,
and enforces one total budget through the injected Timer and an abort signal.
Timing out does not make an uncancellable native command disappear: the platform
adapter must fence or drain that in-flight operation before physical reuse.

The runner returns `non_clean` for unknown/unsupported kinds, incomplete state,
missing baselines, ownership failures, timeout, failed writes or failed readback.
The owning reset dispatch must invoke its erase/destruction fallback, never
interpret `non_clean` as idle admission. That dispatch is not changed here.

## Baseline capture and verification

Capture with `captureFirstDeviceBaseline` under the reset ownership fence before
the first session uses a newly admitted pool device. Capture is first-write-wins;
do not replace a trusted baseline with an already-mutated device's state. The
caller must bound initial capture, just as it bounds other admission work.

A snapshot contains `(kind, key, value)` observations, `completeKinds`, and
explicit `unobservable` reasons. Each complete inventory must be exhaustive: an
omitted key means absent, not unknown. Every `DEVICE_MUTATION_KINDS` entry must
be complete or explicitly unobservable; omission fails closed just like an
explicit blind spot. Complete device settings include all six existing
default-setting keys and locale/appearance.
Every journaled kind also needs observable baseline coverage before a journal
reset can be certified. Missing/changing inventories, duplicate keys and any
unobservable state force fallback even if the observed values happen to match.
Platform adapters must report blind spots instead of claiming a partial scan is
complete, including app data/containers and changes induced by UI, raw commands
or the app under test. A cheap snapshot alone is not a complete erase substitute.

The diff detects changes outside the tool surface. Only an app absent from the
baseline and an originally empty clipboard have generic revert rules; all other
unjournaled changes are dirty. Generic rules still require a qualified platform
port. Journal entries replay in reverse durable order, followed by those generic
steps. A fresh authoritative snapshot must equal the baseline before `clean` is
returned. A write receipt alone cannot establish cleanliness.

## Legacy adapters and remaining wiring

`importLegacySessionMutations` imports the six existing cache restore payloads
without clearing or mutating their slots. The iOS network payload retains the
app rule's owner-generation/revision metadata; its adapter must allocate a newer
reset revision through the existing provider protocol, not replay an old revision.
Import is terminal-only: callers must stop admission, drain all session mutations
and provide `assertQuiesced` under the same lifecycle fence. The importer awaits
that fence before snapshotting and before every write. A conflicting reimport
throws and requires fallback rather than silently retaining stale mutable cache
metadata in a first-write-wins row. Import is not a live write-through adapter.

`JournalDeviceSettingDefaultsPersistence` wraps the existing defaults store:
broker writes first record the six setting originals and broker reads use the
journal's first value. A null broker scope delegates unchanged. Legacy records
store unset settings as null; the journal maps these to `absent`, matching an
omitted baseline key. Legacy records are retained for the existing
retry/next-acquisition behavior. Journal data is
not removed by a legacy defaults deletion.

These adapters are opt-in and are not wired into the current session manager or
tool handlers. Therefore existing non-broker release behavior remains unchanged,
but the full journal-backed release/read-through acceptance criterion is still
pending. Setup writes, readiness side effects, seeders, direct shell commands and
every pending tool adapter must be integrated before keep-booted reuse qualifies.
The existing defaults service catches some persistence failures to preserve its
legacy best-effort behavior; broker tool execution must separately enforce durable
record-before-act rather than treating that best-effort path as sufficient.

Keep journal entries through interrupted/failed resets and through final clean
publication. Only the reset owner may call `deleteSession` after verified cleanup
and successful fenced broker settlement. Retention of retired incarnation
baselines/journals is not automated in this slice; add fenced retirement pruning
before enabling long-lived pooling. Baseline and prior-value payloads can contain
sensitive device data and must not be included in logs or public reports.

Migration 012 advances the registry compatibility boundary even before production
wiring: an older daemon will refuse this upgraded store. Coordinate host daemon
upgrades; do not weaken the existing unsupported-schema safety check. Retirement
pruning remains follow-up work because this slice has no fenced native retirement
owner; pruning during baseline capture could delete recovery state for an active
incarnation.
