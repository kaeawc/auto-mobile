/**
 * Shared per-test body timeout for the file-backed DB lifecycle suites
 * (`databaseLazyPath`, `dbWriteBarrierResetOnClose`, issue #2992).
 *
 * These tests open a real temp `.db` file and run the full startup migration
 * set (30+ files of DDL + backfills) so the app connection sees a schema
 * migrated on a SEPARATE connection. On a cold, loaded `windows-latest` CI
 * runner that legitimately takes several seconds — well past bun's 5s default
 * per-test timeout — so a slow-but-correct run would otherwise read as a
 * failure. This ceiling is generous enough to cover a slow Windows migration
 * yet far below the point where a genuinely hung run would mask a real bug.
 *
 * One canonical constant (rather than an inline literal per suite) keeps the
 * "why 30s" rationale in a single place and guarantees both suites move
 * together if the bound ever needs revisiting.
 */
export const WINDOWS_FILE_DB_TEST_TIMEOUT_MS = 30_000;
