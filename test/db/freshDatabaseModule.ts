/**
 * Shared isolation helper for the DB-lifecycle regression tests
 * (`databaseReset`, `databaseMigrationFailure`, `dbWriteBarrierResetOnClose`).
 *
 * Each of those tests needs a *fresh* `database.ts` module instance so its lazy
 * module-globals (`resolvedDbPath`, `migrationsRun`, `migrationsError`, ...) are
 * isolated, while still sharing the transitive singleton graph (notably the
 * process-global `dbWriteBarrier`, which the barrier test asserts against).
 *
 * They share two cross-file isolation hazards, and this helper closes both:
 *
 * 1. Cache-bust key collisions. `bun test test/db/` runs every file in ONE
 *    process with a shared module registry. A `Date.now()-Math.random()` query
 *    key can (rarely) collide across the ~hundreds of imports the suite does; a
 *    collision makes `import()` hand back an already-booted module whose lazy
 *    globals belong to another test, which surfaces as a stale `resolvedDbPath`
 *    (e.g. a reopen resolving to the previous test's DB dir). A
 *    process-monotonic counter is unique by construction and deterministic — no
 *    `Math.random()`, which the repo bans as an ad-hoc randomness source.
 *
 * 2. Shared mutable `process.env`. All three files mutate the same
 *    `AUTOMOBILE_DB_*` / `*_MIGRATIONS_DIR` keys and each hand-restores its own
 *    subset in `afterEach`. Restoring the WHOLE env removes any dependence on
 *    keeping those key lists complete, so no env state can bleed between tests.
 */

// Shared across all importers (this module is imported without a cache-busting
// query string, so it is a single instance), giving a key that is unique across
// every fresh-module import in the process.
let moduleCounter = 0;

/**
 * Import a fresh `database.ts` module instance with a collision-proof key.
 * The relative transitive imports (e.g. `dbWriteBarrier`) are NOT cache-busted,
 * so they remain the shared singletons the tests rely on.
 */
export function importFreshDatabaseModule(): Promise<typeof import("../../src/db/database")> {
  moduleCounter += 1;
  return import(`../../src/db/database.ts?fresh-db-module=${moduleCounter}`);
}

/** Capture the full environment so it can be restored verbatim after a test. */
export function snapshotEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

/** Restore `process.env` to a snapshot: drop added keys, reinstate removed/changed ones. */
export function restoreEnv(snapshot: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}
