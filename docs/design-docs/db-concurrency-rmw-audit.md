# DB Concurrency RMW Audit

Issues: #3405, #3415

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

| Path                                                           | Strategy                                                                                                                                                                                               | Regression coverage                                                   |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `NavigationRepository.getOrCreateApp`                          | Atomic upsert on `navigation_apps.app_id`; conflict path returns the existing row without changing timestamps.                                                                                         | Existing navigation concurrency tests.                                |
| `NavigationRepository.getOrCreateNode`                         | Atomic upsert on `(app_id, screen_name)`; `visit_count` increments in SQL.                                                                                                                             | Existing navigation tests and `DB concurrency RMW audit`.             |
| `NavigationRepository.getOrCreateUIElement`                    | True SELECT-then-UPDATE/INSERT, guarded by `db.transaction()` unless already bound to a caller transaction.                                                                                            | Existing navigation tests and `DB concurrency RMW audit`.             |
| `NavigationRepository.getOrCreateFingerprint`                  | Atomic upsert on `(app_id, fingerprint_hash)`; `occurrence_count` increments in SQL.                                                                                                                   | Existing navigation concurrency tests.                                |
| `NavigationRepository.addOrUpdateSuggestion`                   | Atomic upsert on `(app_id, fingerprint_hash)`; `occurrence_count` increments in SQL.                                                                                                                   | Existing navigation concurrency tests.                                |
| `FailureAnalyticsRepository.recordFailure`                     | Method-level transaction. Group creation/counting uses atomic upsert; the JSON tool-call-info SELECT-then-UPDATE merge stays inside the transaction.                                                   | Existing failure analytics tests and `DB concurrency RMW audit`.      |
| `TestCoverageRepository.getOrCreateSession`                    | Atomic upsert on `session_uuid`; conflict path returns the existing row.                                                                                                                               | Existing coverage tests and `DB concurrency RMW audit`.               |
| `TestCoverageRepository.recordNodeVisit`                       | Atomic upsert on `(session_id, node_id)`; `visit_count` increments in SQL. Session totals also increment in SQL.                                                                                       | Existing coverage tests and `DB concurrency RMW audit`.               |
| `TestCoverageRepository.recordEdgeTraversal`                   | Atomic upsert on `(session_id, edge_id)`; `traversal_count` increments in SQL. Session totals also increment in SQL.                                                                                   | Existing coverage tests.                                              |
| `PredictionHistoryRepository.upsertTransitionStats`            | Atomic upsert on `(app_id, from_screen, to_screen, tool_name, tool_args)`; attempts, successes, confidence, and brier sums increment in SQL.                                                           | Existing prediction tests and `DB concurrency RMW audit`.             |
| `InstalledAppsRepository.replaceInstalledApps`                 | Delete-then-insert replacement is guarded by a transaction.                                                                                                                                            | Existing installed apps tests.                                        |
| `InstalledAppsRepository.upsertInstalledApp`                   | Atomic upsert on `(device_id, user_id, package_name)`.                                                                                                                                                 | Existing installed apps tests.                                        |
| `DeviceSessionRepository.upsertActiveSession`                  | Atomic upsert on `session_uuid`.                                                                                                                                                                       | Existing device session tests.                                        |
| `KeyedJsonConfigRepository(appearance_configs).setConfig`      | Atomic upsert on the singleton `key`.                                                                                                                                                                  | Existing config tests.                                                |
| `KeyedJsonConfigRepository(device_snapshot_configs).setConfig` | Atomic upsert on the singleton `key`.                                                                                                                                                                  | Existing config tests.                                                |
| `KeyedJsonConfigRepository(video_recording_configs).setConfig` | Atomic upsert on the singleton `key`.                                                                                                                                                                  | Existing config tests.                                                |
| `SqliteFeatureFlagRepository.ensureFlags`                      | Atomic insert with `ON CONFLICT(key) DO NOTHING`, so concurrent default initialization ignores rows another caller already inserted.                                                                   | `DB RMW follow-up fixes (#3415)`.                                     |
| `SqliteFeatureFlagRepository.upsertFlag`                       | Atomic upsert on `feature_flags.key`; omitted config preserves the current config on the conflict path.                                                                                                | `DB RMW follow-up fixes (#3415)`.                                     |
| `recordStorageEvent`                                           | Caller-supplied `previousValue` stays on the zero-lookup fast path; omitted previous-value lookup plus insert runs in one transaction so same-key concurrent inserts observe a serialized prior value. | Existing storage tests and `DB RMW follow-up fixes (#3415)`.          |
| `NavigationRepository.promoteSuggestion`                       | Direct repository calls open a transaction unless already bound to one, so suggestion lookup, fingerprint upsert, and suggestion link update roll back together.                                       | Existing manager rollback tests and `DB RMW follow-up fixes (#3415)`. |

## Guarded Adjacent Paths

These paths are DB-backed feature-manager methods rather than repositories. #3415
guards the same read-modify-write shapes because they were found during the
follow-up review.

| Path                                           | Strategy                                                                                                                                               | Regression coverage               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `ThresholdManager.getOrCreateThresholds`       | The get-valid-then-store initial threshold path runs in a short transaction, preserving one append-only threshold sample for concurrent first callers. | `DB RMW follow-up fixes (#3415)`. |
| `MemoryThresholdManager.getOrCreateThresholds` | The get-valid-then-store initial threshold path runs in a short transaction, preserving one append-only threshold sample for concurrent first callers. | `DB RMW follow-up fixes (#3415)`. |
| `BaselineManager.saveBaseline`                 | Atomic upsert on the unique `screen_id`.                                                                                                               | `DB RMW follow-up fixes (#3415)`. |
| `MemoryBaselineManager.updateBaseline`         | Atomic upsert on `(device_id, package_name, tool_name)`; sample count increments and EMA calculations happen in SQL on the conflict path.              | `DB RMW follow-up fixes (#3415)`. |
| `ThresholdManager.updateThresholdWeight`       | Atomic SQL update of the latest `(device_id, session_id)` threshold row; the multiplier applies to the current stored weight.                          | `DB RMW follow-up fixes (#3415)`. |
| `MemoryThresholdManager.updateThresholdWeight` | Atomic SQL update of the latest `(device_id, package_name)` threshold row; the multiplier applies to the current stored weight.                        | `DB RMW follow-up fixes (#3415)`. |

## Follow-Up Candidates

No unguarded repository RMW follow-up candidates remain from #3415.

## Adjacent Follow-Up Candidates

No unguarded adjacent manager RMW follow-up candidates remain from #3415.

`SessionManager.getOrCreateSession` is an in-memory session-map operation; its
persistence path goes through `DeviceSessionRepository.upsertActiveSession`,
which is listed above.
