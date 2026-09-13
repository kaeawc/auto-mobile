import { describe, expect, test } from "bun:test";
import type { Kysely, MigrationLockOptions } from "kysely";
import { SqliteAdapter } from "kysely";

/**
 * Pins the exact Kysely `SqliteAdapter` behaviors that
 * `src/db/migrationLock.ts` and `src/db/migrator.ts` depend on but never
 * exercise directly (issue #6701):
 *
 * - `FileMigrationLock` (`src/db/migrationLock.ts:21-30`) exists ONLY because
 *   Kysely's SQLite adapter provides no cross-process migration lock —
 *   `acquireMigrationLock`/`releaseMigrationLock` are no-ops. If a future
 *   Kysely version implemented a real lock here, AutoMobile's file lock would
 *   become redundant (harmless) or could interact with it in an unreviewed
 *   way.
 * - The migration recovery path (`src/db/migrator.ts` — `rebuildMigrationTable`,
 *   `resetDatabaseState`, and the migrations under `src/db/migrations/` that
 *   comment on this, e.g. `2026_07_01_000_failure_groups_signature_unique.ts:12`
 *   and `2026_08_02_000_navigation_provenance.ts:121`) assumes
 *   `supportsTransactionalDdl === false`: a failed migration is NOT rolled back
 *   by Kysely, so recovery must be idempotent/rerunnable rather than relying on
 *   transactional DDL rollback.
 *
 * Every existing migration-lock/migrator test exercises only AutoMobile's OWN
 * injected `MigrationLock` (see `migrationLock.integration.test.ts`,
 * `migratorLock.integration.test.ts`), so a Kysely upgrade that changed either
 * contract would pass all of them silently. This test imports the REAL
 * `SqliteAdapter` from the installed `kysely` package (currently `0.29.5`, see
 * `package.json`) and would fail — with a message pointing back here — the
 * moment either contract changes.
 */
describe("Kysely SqliteAdapter contract (issue #6701)", () => {
  test("supportsTransactionalDdl is false — migration recovery in migrator.ts assumes no DDL rollback", () => {
    const adapter = new SqliteAdapter();

    expect(adapter.supportsTransactionalDdl).toBe(false);
  });

  test("acquireMigrationLock/releaseMigrationLock are no-ops — issue no SQL and never read db/options", async () => {
    const adapter = new SqliteAdapter();

    // A future Kysely version implementing a real SQLite migration lock would
    // need to query through `db` (e.g. the lock table named in `options`) or
    // read `options` to find it. Poisoning every property access on both
    // arguments proves the current no-op contract: the migration-lock methods
    // touch neither, which is exactly why `FileMigrationLock` in
    // `src/db/migrationLock.ts` had to be added as AutoMobile's OWN
    // cross-process lock.
    const poison = (label: string) =>
      new Proxy(
        {},
        {
          get(_target, prop) {
            throw new Error(
              `SqliteAdapter accessed ${label}.${String(prop)} during a migration-lock call. ` +
                "Kysely's SQLite adapter is assumed to be a pure no-op here (src/db/migrationLock.ts:21-30) " +
                "— re-evaluate FileMigrationLock and the migration recovery path in src/db/migrator.ts " +
                "before upgrading kysely.",
            );
          },
        },
      );

    const poisonedDb = poison("db") as unknown as Kysely<unknown>;
    const poisonedOptions = poison("options") as unknown as MigrationLockOptions;

    await expect(
      adapter.acquireMigrationLock(poisonedDb, poisonedOptions),
    ).resolves.toBeUndefined();
    await expect(
      adapter.releaseMigrationLock(poisonedDb, poisonedOptions),
    ).resolves.toBeUndefined();
  });
});
