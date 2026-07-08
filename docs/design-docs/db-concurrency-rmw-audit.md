# DB Concurrency RMW Audit

Issue: #3405

## Context

The Bun SQLite dialect serializes individual statements with an in-process mutex,
but autocommit callers release that mutex across every `await`. Any repository
method that performs a read, awaits, then writes based on that read must therefore
be protected by either:

- a SQLite transaction that holds the single connection for the full unit, or
- an atomic `INSERT ... ON CONFLICT DO UPDATE` upsert with counter changes done in
  SQL.

The regression stress coverage lives in `test/db/dbConcurrencyAudit.test.ts` and
uses `test/db/concurrencyStressHelper.ts` with `createTestDatabase()`. That test
exercises the real `BunSqliteDialect` and an in-memory `bun:sqlite` database, so
the same dialect mutex is used without resolving the guarded file-backed
singleton under `bun test`.

## Guarded Paths

These paths either used to be read-modify-write or are current same-key
get-or-create/update contracts. They are covered by a transaction or atomic
upsert.

| Path | Strategy | Regression coverage |
| --- | --- | --- |
| `NavigationRepository.getOrCreateApp` | Atomic upsert on `navigation_apps.app_id`; conflict path returns the existing row without changing timestamps. | Existing navigation concurrency tests. |
| `NavigationRepository.getOrCreateNode` | Atomic upsert on `(app_id, screen_name)`; `visit_count` increments in SQL. | Existing navigation tests and `DB concurrency RMW audit`. |
| `NavigationRepository.getOrCreateUIElement` | True SELECT-then-UPDATE/INSERT, guarded by `db.transaction()` unless already bound to a caller transaction. | Existing navigation tests and `DB concurrency RMW audit`. |
| `NavigationRepository.getOrCreateFingerprint` | Atomic upsert on `(app_id, fingerprint_hash)`; `occurrence_count` increments in SQL. | Existing navigation concurrency tests. |
| `NavigationRepository.addOrUpdateSuggestion` | Atomic upsert on `(app_id, fingerprint_hash)`; `occurrence_count` increments in SQL. | Existing navigation concurrency tests. |
| `FailureAnalyticsRepository.recordFailure` | Method-level transaction. Group creation/counting uses atomic upsert; the JSON tool-call-info SELECT-then-UPDATE merge stays inside the transaction. | Existing failure analytics tests and `DB concurrency RMW audit`. |
| `TestCoverageRepository.getOrCreateSession` | Atomic upsert on `session_uuid`; conflict path returns the existing row. | Existing coverage tests and `DB concurrency RMW audit`. |
| `TestCoverageRepository.recordNodeVisit` | Atomic upsert on `(session_id, node_id)`; `visit_count` increments in SQL. Session totals also increment in SQL. | Existing coverage tests and `DB concurrency RMW audit`. |
| `TestCoverageRepository.recordEdgeTraversal` | Atomic upsert on `(session_id, edge_id)`; `traversal_count` increments in SQL. Session totals also increment in SQL. | Existing coverage tests. |
| `PredictionHistoryRepository.upsertTransitionStats` | Atomic upsert on `(app_id, from_screen, to_screen, tool_name, tool_args)`; attempts, successes, confidence, and brier sums increment in SQL. | Existing prediction tests and `DB concurrency RMW audit`. |
| `InstalledAppsRepository.replaceInstalledApps` | Delete-then-insert replacement is guarded by a transaction. | Existing installed apps tests. |
| `InstalledAppsRepository.upsertInstalledApp` | Atomic upsert on `(device_id, user_id, package_name)`. | Existing installed apps tests. |
| `DeviceSessionRepository.upsertActiveSession` | Atomic upsert on `session_uuid`. | Existing device session tests. |
| `AppearanceConfigRepository.setConfig` | Atomic upsert on the singleton `key`. | Existing config tests. |
| `DeviceSnapshotConfigRepository.setConfig` | Atomic upsert on the singleton `key`. | Existing config tests. |
| `VideoRecordingConfigRepository.setConfig` | Atomic upsert on the singleton `key`. | Existing config tests. |

## Follow-Up Candidates

These paths still perform separate awaited reads and writes without a local
transaction or atomic upsert. They were not fixed as part of #3405 because the
acceptance criteria ask for follow-up fixes for any unguarded path found.

| Path | Current behavior | Follow-up direction |
| --- | --- | --- |
| `SqliteFeatureFlagRepository.ensureFlags` | Reads all existing flag keys, computes missing definitions in JS, then inserts the missing rows. Concurrent first initialization can race on the primary key. | Convert to `INSERT ... ON CONFLICT DO NOTHING` or a transaction. |
| `SqliteFeatureFlagRepository.upsertFlag` | SELECTs by key, then UPDATEs or INSERTs. Concurrent first writes can race on the primary key. | Replace with `insertInto(...).onConflict(...doUpdateSet(...))`. |
| `recordStorageEvent` | When `previousValue` is omitted, SELECTs the latest same device/file/key value, then inserts a new event with that value. Concurrent inserts can observe the same prior value. | Decide whether previous-value derivation is best-effort telemetry or must be serialized per key; then either document best-effort semantics or guard the lookup+insert. |
| `NavigationRepository.promoteSuggestion` | Direct raw repository callers SELECT a suggestion, upsert a fingerprint, then update the suggestion outside a transaction. The public `NavigationGraphManager.promoteSuggestion` path already wraps this in `runInTransaction`/`withExecutor`, but the repository method itself does not enforce that contract. | Either make the repository method transaction-safe for direct use or narrow its visibility/contract so callers cannot bypass the manager-owned transaction. |

## Adjacent Non-Repository Paths

`ThresholdManager.getOrCreateThresholds` and
`MemoryThresholdManager.getOrCreateThresholds` also read existing threshold rows
before storing new threshold rows, but they live in feature managers rather than
DB repositories and write append-only threshold history rather than enforcing a
single-row get-or-create contract. Concurrent callers may insert duplicate
threshold samples. If that is undesirable, track it as a threshold-history
deduplication issue rather than as part of the repository RMW audit.

`SessionManager.getOrCreateSession` is an in-memory session-map operation; its
persistence path goes through `DeviceSessionRepository.upsertActiveSession`,
which is listed above.
