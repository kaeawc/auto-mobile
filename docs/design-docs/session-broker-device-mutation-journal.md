# Device mutation journal and baseline reset contract

## Delivery boundary

This is the contract/persistence/planning and tool-recording slice of #14359 under
#14358. It does not change keep-booted reset admission. The iOS (#14361) and
Android (#14364) lanes own platform cleaning and reset wiring.
`DEVICE_MUTATION_TOOL_COVERAGE` explicitly lists three statuses: `journaled` tools
attempt record-before-act in production; `pending-adapter` tools have no production
journal adapter yet; `notJournaled` tools are intentional host-only or transient
UI/prompt exemptions. Pending adapters and exemptions include their reasons.
Its registry enumeration test includes mixed, hidden and SDK
tools, and rejects a new control tool without an explicit justification.
The 37 journaled tools include the original 26 tool adapters plus 11 data/provider
adapters: `setKeyValue`, `removeKeyValue`, `clearKeyValueFile`, `setPreference`,
`sqlQuery`, `mockNetwork`, `clearMockNetwork`, `sendSms`, `phoneCall`,
`resetAppLogs` and `deviceSnapshot`. The coverage proof exercises every journaled
classification through record-before-act dispatch. `stageSessionDownloads` is
still pending: its deprecated alias runs via `nonDeviceHandler` and resolves the
device inside the service, bypassing the recorded device dispatcher. A mapping
alone would not journal that production path; service-side wiring is required.

For a `journaled` mutation, production tool dispatch records its intent before
the action under the broker recorder scope. On iOS that is the scope the
keep-booted reset and the pool-entry baseline read, the pooled slot's simulator
`[scopeKey, allocationIndex, udid]`, so the reset replays the session's
tool-recorded intents and deletes them afterwards (#14790). On Android the
incarnation is `resourceId + assignmentGeneration`, which the Android keep-booted
reset does not read today, so Android tool-recorded intents are not replayed in
this slice. A prior is revertible only when
`deviceMutationPriorReader.ts` has a reader for that mutation's kind and key;
otherwise the prior is `unobservable`/opaque and reverts are best-effort only.
Full acceptance criterion 2 still
requires the pending adapters, and criterion 3 (journal-backed release/read-through)
remains unmet; #14359 must not close as fully delivered on this slice.
Neither `pending-adapter` nor `notJournaled` implies production journaling.
The optional Android (#14364) and iOS (#14361) keep-booted strategies capture
partial baselines and run best-effort cleaning. `persona` and `statusBar` remain
`pending-adapter`: device-appearance intent and prior-value adapters are not yet
wired. Their missing coverage limits journal intent coverage, not baseline capture,
tool execution or keep-booted reuse.

Owner decision: keep-booted resets run their cleaning operations unconditionally.
The journal is not an admission gate or a prerequisite for cleaning. In this
slice, recorder/reset scope mismatch means tool-recorded intents do not drive
best-effort reverts. Aligning those scopes and making revert failures
warn-and-continue rather than force a keep-booted fallback remain follow-up work
under #14359. Unknown kinds, unobservable priors, missing adapters and incomplete
journal/baseline coverage must not introduce new blocking. Existing main reset
ownership, readiness, cleanup and publication checks remain unchanged.
An unavailable recorder for a broker session means recorder recovery failed.
Recorder binding and recovery failures, recorder scope mismatches, and journal
I/O failures warn and let acquisition or tool actions proceed without recording;
a missing recorder for a non-broker session is expected and does not warn.
Successful recording retains first-write-wins and record-before-act ordering.
An aborted call signal still prevents the action; cancellation is not ignored.

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

`applyJournaledMutation` is a standalone helper with no production tool-dispatch
caller. Production tool dispatch records before acting, but warns and proceeds
if persistence fails; recording is an aid, not a gate. First write per
`(scope, kind, key)` wins. `appliedAt` timestamps the mutation intent, not a
successful device acknowledgement. SQLite's sequence provides deterministic
reverse ordering even when timestamps coincide or the wall clock moves.
Failed/ambiguous mutations retain their intent so recovery can safely retry.

The prior value is a tagged JSON value: `{ state: "absent" }` is distinct from
both JSON null and the literal string `"absent"`. Unknown kinds remain durable
and are non-revertible in the standalone planner; schema evolution must not
discard them. That diagnostic does not gate keep-booted cleaning.

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

Keep-booted bounds its own journal capture to the 30-second cleaning budget (or
the remaining preparation deadline, whichever is shorter); other strategies and
fallback capture receive the remaining preparation deadline. Reset fallback has
its own budget and abort signal. After timeout or cancellation, the owner awaits
cleaning or fallback settlement with a separate two-second drain bound before
returning a failure that permits device destruction. An adapter that never settles
exhausts that drain and fails without starting snapshot fallback; adapters must
honor cancellation to guarantee native commands have stopped before teardown.
Resource pruning is best-effort: database
failures log a warning without retaining in-memory sessions or skipping teardown.

The standalone journal runner returns `non_clean` for unknown/unsupported kinds,
incomplete state, missing baselines, ownership failures, timeout, failed writes
or failed readback. It is not wired as a keep-booted admission gate. Its result
does not replace or prevent the platform's unconditional cleaning operations;
existing main reset dispatch and fallback behavior are not changed here.

## Baseline capture and verification

Capture with `captureFirstDeviceBaseline` under the reset ownership fence before
the first session uses a newly admitted pool device. Capture is first-write-wins;
do not replace a trusted baseline with an already-mutated device's state. The
caller must bound initial capture, just as it bounds other admission work.

A snapshot contains `(kind, key, value)` observations, `completeKinds`, and
explicit `unobservable` reasons. Each complete inventory must be exhaustive: an
omitted key means absent, not unknown. Every `DEVICE_MUTATION_KINDS` entry must
be complete or explicitly unobservable for the standalone runner; omission
fails its certification like an explicit blind spot, not keep-booted admission.
Complete device settings include all existing
default-setting keys and locale/appearance.
Every journaled kind needs observable baseline coverage for the standalone
journal runner to certify its own result. Missing/changing inventories, duplicate
keys and unobservable state prevent that certification even if observed values
match; they do not gate or force fallback in keep-booted resets.
Platform adapters must report blind spots instead of claiming a partial scan is
complete, including app data/containers and changes induced by UI, raw commands
or the app under test. A cheap snapshot alone is not a complete erase substitute.

The diff detects changes outside the tool surface. Only an app absent from the
baseline and an originally empty clipboard have generic revert rules; all other
unjournaled changes are dirty. Generic rules still require a qualified platform
port. Journal entries replay in reverse durable order, followed by those generic
steps. A fresh authoritative snapshot must equal the baseline before `clean` is
returned by the standalone runner. A write receipt alone cannot establish that
result. Keep-booted resets still perform their cleaning operations unconditionally.

## Legacy adapters and remaining wiring

`importLegacySessionMutations` imports the six existing cache restore payloads
without clearing or mutating their slots. The iOS network payload retains the
app rule's owner-generation/revision metadata; its adapter must allocate a newer
reset revision through the existing provider protocol, not replay an old revision.
Import is terminal-only: callers must stop admission, drain all session mutations
and provide `assertQuiesced` under the same lifecycle fence. The importer awaits
that fence before snapshotting and before every write. A conflicting reimport
throws rather than silently retaining stale mutable cache metadata in a
first-write-wins row. Import is not a live write-through adapter or a keep-booted
reset gate.

Legacy-restorer import (AC3) is deferred. Shared `device` keys do not imply
compatible values: tool clock priors are `{ instant, automaticTime }`, whereas
`ClockSessionState` stores `{ initialAutomaticTime, clockChangedByUs, rootedByUs }`.
Tool network priors use `values ?? observedValues ?? profile`, whereas the legacy
restorer stores `{ initialProfile, iosAppRule }`. Importing both into one scoped
key would fail the importer's deep-equality check. A captured clock instant also
ages before restore. Value normalization and clock restore semantics must be
resolved before wiring these opt-in legacy adapters; this slice does not fix them.

`JournalDeviceSettingDefaultsPersistence` wraps the existing defaults store:
broker writes first record the setting originals and broker reads use the
journal's first value. A null broker scope delegates unchanged. Legacy records
store unset settings as null; the journal maps these to `absent`, matching an
omitted baseline key. Legacy records are retained for the existing
retry/next-acquisition behavior. Journal data is
not removed by a legacy defaults deletion.

These adapters are opt-in and are not wired into the current session manager or
tool handlers. Therefore existing non-broker release behavior remains unchanged,
but the full journal-backed release/read-through acceptance criterion is still
pending. Setup writes, readiness side effects, seeders, direct shell commands and
pending tool adapters remain incomplete journal coverage, not new keep-booted
reuse prerequisites.
The existing defaults service catches some persistence failures to preserve its
legacy best-effort behavior; broker tool execution separately attempts durable
record-before-act, warning and proceeding without recording on journal failure.

Keep journal entries through interrupted/failed resets and through final clean
publication. Only the reset owner may call `deleteSession` after verified cleanup
and successful fenced broker settlement. Retention of retired incarnation
baselines/journals is not automated in this slice; fenced retirement pruning
remains follow-up work, not a keep-booted cleaning gate. Per-session recorder
rows also accumulate in the host registry until the follow-up pruning/consumption
work lands. Baseline and prior-value payloads can contain
sensitive device data and must not be included in logs or public reports.

## Tool-surface recovery and compatibility

Data-store identities retain the app, store, Android user selector and key;
set/remove operations and `name`/`fileName` aliases share a first-write identity.
iOS key-value standard-store aliases (empty name, case-insensitive `standard`,
and app bundle ID) share an identity, as do UserDefaults preference standard-suite
aliases (including omitted suite and `Standard`). Android omitted and explicit
`userId` selectors are not merged: the default user is resolved dynamically from
the app's installed/running users and is not necessarily user 0.
Identities are not merged across tools: `setKeyValue` and `setPreference` can
touch the same SharedPreferences file or standard UserDefaults and still get
separate first-write rows, so a future restorer must not assume they are merged.
Store clearing records the observed entries under a separate whole-store key.
Key-value priors use an existing connected SDK's storage read path, preserving
the entry's encoded value and type. Missing keys are `absent`; an empty store is
`present` with an empty entry list, not proof that the backing file was absent.
Unconnected providers, redacted/unknown entries and explicitly user-scoped
Android key-value calls record `unobservable` (the SDK route is not user-scoped).
Preference priors reuse `AppPreferences.getPreference`, retaining value, type and
resolved user/store metadata. Redacted, lossy or potentially stale container-plist
reads are `unobservable`. Read failures warn and still record intent before action.

SQL uses the existing read-only classifier: proven reads do not journal; mutations
and unproven statements record opaque database intent without trying to infer an
inverse query. Network mock creation/clearing share opaque intent, not an invented
device prior from host-owned rules. Telephony, log deletion (including rotated
siblings) and snapshot capture/restore record opaque intent without claiming a
complete or reversible prior. These adapters do not implement restorers or change
keep-booted cleaning, and unreadable priors never block the tool action.

Journaled non-read calls with an empty adapter result record an opaque
`unobservable` intent instead of silently proceeding. `screenLock` is covered;
its reader can capture an unsecured baseline, but cannot recover an existing
secure credential, so it records `unobservable` without storing secrets or adding
a keep-booted gate. Prior reads are skipped when the scoped `(kind, key)` already
exists, using one journal list per call. Rotation and screen-reader keys use
`device`, matching the legacy adapters. iOS rotation records `unobservable`
instead of inventing portrait orientation or attempting Android orientation reads.

Keyboard open/close and biometric match/fail/cancel/error actions are explicitly
`notJournaled` transient prompt/UI actions. Keyboard setProfile persists typing
policy on the device and records the active profile from listProfiles under the
separate `keyboard:profile` key, or `unobservable` if unreadable. Keyboard
tapImeKey records an opaque/unobservable keyboard prior because a failed IME
restore can leave the device switched. Selecting an installed IME and changing
enrollment remain journaled. These unknown priors do not prevent the action or
unconditional keep-booted cleaning.

Install intents resolve the artifact's package/bundle identifier before installing,
using the existing installer metadata readers. In this slice, `installed-app`
priors read the pool-entry baseline on iOS. On Android, priors that need an
incarnation baseline are `unobservable` because the recorder scope does not match
the baseline/reset scope. Unknown metadata or incomplete
inventory also records `unobservable` without blocking installation or
keep-booted cleaning. Installed-app and uninstall keys share the baseline app
identity when metadata is readable.

Recovery uses the registry's unique session-id index, not an all-receipts scan.
Startup warns and continues for an individually unrecoverable session; its future
mutations warn and proceed without recording if recovery still fails. A fatal
startup error closes the broker before
releasing its host lock. A rebound session discards its old recorder and resolves
the new native assignment before the next mutation.

Derived label routing sessions intentionally do not record into the base recorder:
they can target a different physical device and have no broker resource/incarnation
receipt of their own. Their independent devices have no journal-led best-effort
reverts; existing native lifecycle cleanup remains unchanged.
The registry explicitly recognizes these sessions before recovery, avoiding a
receipt lookup on every routed call.

The `unobservable` mutation-value tag is also a compatibility boundary within the
current registry schema version. Older daemons that accept the same migration but
do not understand the tag fail closed when listing those rows. Upgrade all daemons
sharing a host registry before new writers run; never discard or reinterpret an
unknown prior as absent to make an older reader accept it.

Migration 012 advances the registry compatibility boundary even before production
wiring: an older daemon will refuse this upgraded store. Coordinate host daemon
upgrades; do not weaken the existing unsupported-schema safety check. Retirement
pruning remains follow-up work because this slice has no fenced native retirement
owner; pruning during baseline capture could delete recovery state for an active
incarnation.
