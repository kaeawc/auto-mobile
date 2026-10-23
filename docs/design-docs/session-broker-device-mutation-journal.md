# Device mutation journal and baseline reset contract

## Delivery boundary

Contract, persistence, planning and tool-recording slice of #14359 under #14358.
It does not change keep-booted reset admission; iOS (#14361) and Android (#14364)
own platform cleaning and reset wiring.

`DEVICE_MUTATION_TOOL_COVERAGE` assigns every control tool one status:
`journaled` (production dispatch attempts record-before-act), `pending-adapter`
(no production adapter yet), `notJournaled` (intentional host-only or transient
UI/prompt exemption). Pending/exempt entries carry reasons; a registry
enumeration test (including mixed, hidden and SDK tools) rejects a new control
tool without a justification. Neither `pending-adapter` nor `notJournaled` implies
journaling.

- 37 journaled tools: the original 26 plus data/provider adapters `setKeyValue`,
  `removeKeyValue`, `clearKeyValueFile`, `setPreference`, `sqlQuery`,
  `mockNetwork`, `clearMockNetwork`, `sendSms`, `phoneCall`, `resetAppLogs`,
  `deviceSnapshot`.
- Pending: `manufacturerProfile`,
  `statusBar` (appearance intent/prior adapters not wired). This limits journal
  intent coverage, not baseline capture, tool execution or keep-booted reuse.
- Recording uses the broker recorder scope, incarnation `resourceId +
  assignmentGeneration`. The iOS and Android keep-booted resets do not read that
  scope today, so tool-recorded intents are not replayed by them. A prior is
  revertible only when `deviceMutationPriorReader.ts` has a reader for the
  mutation's kind and key; otherwise it is `unobservable`/opaque (best-effort
  reverts only).
- Acceptance criterion 2 (all adapters) and 3 (journal-backed release/read-through)
  remain unmet; #14359 is not fully delivered by this slice.

**Owner decision**: keep-booted resets run their cleaning operations
unconditionally. The journal is neither an admission gate nor a cleaning
prerequisite; unknown kinds, unobservable priors, missing adapters and incomplete
coverage must not add blocking. Follow-up under #14359: align recorder/reset scopes
and make revert failures warn-and-continue instead of forcing fallback. Existing
main reset ownership, readiness, cleanup and publication checks are unchanged.

**Recorder failure policy**: unavailable recorder for a broker session means
recovery failed; recorder binding/recovery failures, scope mismatches and journal
I/O failures warn and let the action proceed unrecorded. A missing recorder for a
non-broker session is expected (no warning). Success keeps first-write-wins and
record-before-act ordering; an aborted call signal still prevents the action.

## Identity and persistence

`SqliteBindingRegistry.deviceMutationJournal()` shares the host registry SQLite
connection. Migration `2026_10_21_012_device_mutation_journal` adds
`device_mutation_journal` and `device_mutation_baselines` to the store's static
migration set (not the per-daemon database migrations).

- Identity is `(sessionUuid, deviceId, incarnation)`. The incarnation must be a
  durable native resource generation that survives restarts and changes when the
  device is replaced; a process-local counter or reusable serial is insufficient.
  Baselines are shared across sessions of one incarnation, never across
  replacements.
- `applyJournaledMutation` is a standalone helper with no production dispatch
  caller. First write per `(scope, kind, key)` wins. `appliedAt` stamps intent, not
  device acknowledgement. SQLite's sequence gives deterministic reverse order
  regardless of clock. Failed/ambiguous mutations keep their intent so recovery
  can retry.
- Prior value is a tagged JSON value: `{ state: "absent" }` is distinct from JSON
  null and the string `"absent"`. Unknown kinds stay durable and are
  non-revertible in the planner (schema evolution must not discard them).

## Platform port obligations

- `DeviceMutationResetPort.canRevert` qualifies kind, key and prior payload.
  `revert` sets the original absolute state, tolerates already-absent resources,
  and is idempotent on replay. Compound priors may carry app-group identities or
  legacy restore metadata; adapters preserve platform-required ordering inside a
  step and may map steps to apply/verify/revert profiles (#14067). The contract
  contains no platform commands.
- Every device I/O dispatch awaits `context.assertOwned()` immediately before
  acting and honors `context.signal`, including after queued or delayed awaits.
  The runner checks ownership before each phase/step and after verification, and
  enforces one total budget via the injected Timer and an abort signal. A timeout
  does not stop an uncancellable native command: the adapter must fence or drain it
  before physical reuse.
- Keep-booted bounds journal capture to the 30 s cleaning budget (or remaining
  preparation deadline if shorter); other strategies and fallback capture get the
  remaining preparation deadline. Fallback has its own budget and abort signal.
  After timeout/cancel the owner awaits cleaning/fallback settlement with a separate
  2 s drain; an adapter that never settles exhausts it and fails without starting
  snapshot fallback, permitting destruction. Resource pruning is best-effort:
  database failures warn without retaining in-memory sessions or skipping teardown.
- The standalone runner returns `non_clean` for unknown kinds, incomplete state,
  missing baselines, ownership failures, timeout, failed writes or failed readback.
  It is not a keep-booted gate and does not replace or prevent platform cleaning.

## Baseline capture and verification

Capture with `captureFirstDeviceBaseline` under the reset ownership fence before the
first session uses a newly admitted pool device; first-write-wins, never replacing a
trusted baseline with an already-mutated device's state. Callers bound initial
capture like other admission work.

- A snapshot holds `(kind, key, value)` observations, `completeKinds`, and explicit
  `unobservable` reasons. A complete inventory is exhaustive (omitted key = absent,
  not unknown). For the standalone runner every `DEVICE_MUTATION_KINDS` entry must
  be complete or explicitly unobservable; omission, missing/changing inventories,
  duplicate keys and unobservable state prevent its certification even when values
  match. None of this gates or forces fallback in keep-booted resets.
- Complete device settings cover all default-setting keys plus locale/appearance.
  Adapters must report blind spots (app data/containers, changes induced by UI, raw
  commands or the app under test) rather than call a partial scan complete; a cheap
  snapshot is not a complete erase substitute.
- The diff detects changes outside the tool surface. Only an app absent from the
  baseline and an originally empty clipboard have generic revert rules (still
  needing a qualified port); all other unjournaled changes are dirty. Journal
  entries replay in reverse durable order, then generic steps; the standalone runner
  returns `clean` only when a fresh authoritative snapshot equals the baseline (a
  write receipt is not enough).

## Legacy adapters and remaining wiring

- `importLegacySessionMutations` imports the six legacy cache restore payloads
  without clearing slots. The iOS network payload keeps the app rule's
  owner-generation/revision metadata; its adapter must allocate a newer reset
  revision via the provider protocol, not replay an old one. Import is
  terminal-only: callers stop admission, drain session mutations and provide
  `assertQuiesced` under the lifecycle fence, awaited before snapshotting and
  before every write. A conflicting reimport throws rather than keep stale metadata
  in a first-write-wins row. It is not a live write-through adapter or a gate.
- Legacy-restorer import (AC3) is deferred: shared `device` keys hold incompatible
  values (tool clock priors `{ instant, automaticTime }` vs `ClockSessionState`
  `{ initialAutomaticTime, clockChangedByUs, rootedByUs }`; tool network priors
  `values ?? observedValues ?? profile` vs `{ initialProfile, iosAppRule }`), which
  would fail the deep-equality check, and a captured clock instant ages before
  restore. Normalization and clock-restore semantics must be resolved first.
- `JournalDeviceSettingDefaultsPersistence` wraps the defaults store: broker writes
  first record setting originals and broker reads use the journal's first value; a
  null broker scope delegates unchanged. Legacy null (unset) maps to `absent`.
  Legacy records stay for retry/next-acquisition behavior; legacy deletion does not
  remove journal data. The defaults service still swallows some persistence
  failures (legacy best-effort), while broker tool execution separately warns and
  proceeds on journal failure.
- These adapters are opt-in and not wired into the session manager or tool handlers,
  so non-broker release is unchanged. Setup writes, readiness side effects, seeders,
  direct shell commands and pending adapters are incomplete journal coverage, not
  reuse prerequisites.
- Keep entries through interrupted/failed resets and final clean publication. Only
  the reset owner calls `deleteSession`, after verified cleanup and fenced broker
  settlement. Retirement pruning of baselines/journals and per-session recorder
  rows is follow-up (no fenced native retirement owner yet; pruning during capture
  could delete recovery state for an active incarnation). Baseline and prior
  payloads may contain sensitive device data: never log or report them.

## Tool-surface recovery and compatibility

**Data stores**

- Identities keep app, store, Android user selector and key; set/remove and
  `name`/`fileName` aliases share a first-write identity. iOS key-value
  standard-store aliases (empty name, case-insensitive `standard`, bundle ID) and
  UserDefaults standard-suite aliases (omitted suite, `Standard`) share one.
  Android omitted vs explicit `userId` are not merged (default user is resolved
  dynamically, not necessarily 0). Identities are not merged across tools:
  `setKeyValue` and `setPreference` on the same file get separate rows, so a future
  restorer must not assume otherwise. Store clearing records observed entries under
  a separate whole-store key.
- Key-value priors use a connected SDK's storage read path (encoded value and type
  preserved). Missing key = `absent`; an empty store is `present` with no entries,
  not proof the file was absent. Unconnected providers, redacted/unknown entries and
  explicitly user-scoped Android calls record `unobservable`. Preference priors reuse
  `AppPreferences.getPreference` (value, type, resolved user/store); redacted, lossy
  or possibly stale container-plist reads are `unobservable`. Read failures warn and
  still record intent.
- SQL uses the read-only classifier: proven reads do not journal; mutations and
  unproven statements record opaque intent (no inferred inverse). Network mocks
  share opaque intent (no invented prior from host-owned rules). Telephony, log
  deletion (including rotated siblings) and snapshot capture/restore record opaque
  intent. None implement restorers or change cleaning; unreadable priors never block
  the action.

**Other tools**

- Journaled non-read calls with an empty adapter result record opaque
  `unobservable` intent. `screenLock` can capture an unsecured baseline but not an
  existing secure credential, so it records `unobservable` without storing secrets.
  `power` records `unobservable` because its restore registry (`restoreReceipt`,
  `powerRestore`) owns the priors. Prior reads are skipped when the scoped
  `(kind, key)` already exists (one journal list per call). Rotation and
  screen-reader keys use `device`, matching legacy adapters; iOS rotation records
  `unobservable` rather than invent portrait or read Android orientation.
- Keyboard open/close and biometric match/fail/cancel/error are `notJournaled`
  transient UI. Keyboard `setProfile` persists typing policy and records the
  `listProfiles` active profile under `keyboard:profile` (or `unobservable`);
  `tapImeKey` records opaque `unobservable` since a failed IME restore can leave the
  device switched. Selecting an installed IME and changing enrollment stay
  journaled.
- Install intents resolve the artifact's package/bundle identifier via the existing
  metadata readers. In this slice `installed-app` priors needing an incarnation
  baseline are `unobservable` (recorder scope does not match baseline/reset scope);
  unknown metadata or incomplete inventory also records `unobservable`, never
  blocking install or cleaning. Install and uninstall keys share the baseline app
  identity when metadata is readable.

**Recovery**

- Uses the registry's unique session-id index, not an all-receipts scan. Startup
  warns and continues for an unrecoverable session (its later mutations warn and go
  unrecorded). A fatal startup error closes the broker before releasing the host
  lock. A rebound session discards its old recorder and resolves the new native
  assignment before the next mutation.
- Derived label routing sessions do not record into the base recorder (they may
  target another device and have no resource/incarnation receipt); they have no
  journal-led reverts, and native lifecycle cleanup is unchanged. The registry
  recognizes them before recovery to avoid a receipt lookup per routed call.

**Schema compatibility**: the `unobservable` tag is a compatibility boundary within
the current registry schema version: older daemons that accept the migration but not
the tag fail closed when listing those rows. Upgrade all daemons sharing a host
registry before new writers run; never discard or reinterpret an unknown prior as
absent. Migration 012 itself advances the boundary, so an older daemon refuses the
upgraded store; do not weaken the unsupported-schema check.
