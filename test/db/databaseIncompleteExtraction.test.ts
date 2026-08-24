import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import path from "path";
import { mkdir, writeFile } from "node:fs/promises";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { isIncompleteExtractionError } from "../../src/db/migrationDependencyIntegrity";
import { createFileBackedDbHarness } from "./withFileBackedDb";

/**
 * Issue #2833: the incomplete-extraction mapping is scoped to KNOWN migration
 * runtime dependencies. This drives the REAL migrator path with a migration that
 * imports a package which is not a declared dependency — a genuine code-level bad
 * import — and asserts it surfaces the GENERIC startup-migration error rather
 * than being mislabeled as a recoverable "re-extract" incomplete extraction.
 *
 * (The positive case — a missing KNOWN dependency such as `kysely` — cannot be
 * reproduced in-repo because bun resolves `kysely` from its global install
 * cache; that mapping is covered by the unit tests for
 * isMissingMigrationDependencyError + createIncompleteExtractionError.)
 */
describe("startup migration failure does not mislabel a genuine bad import", () => {
  // Shared harness: fresh module import, tracked temp dirs cleaned with the
  // bounded `removeTempDbDir`, and full-env snapshot/restore (issue #3046).
  let harness = createFileBackedDbHarness();

  beforeEach(() => {
    harness = createFileBackedDbHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  test("an unknown missing package surfaces the generic error, not incomplete-extraction", async () => {
    const tempDir = await harness.makeTempDbDir("am-bad-import-");
    const migrationsDir = path.join(tempDir, "migrations");
    await mkdir(migrationsDir, { recursive: true });

    // A migration whose runtime value import cannot be resolved and is NOT a
    // declared migration dependency (i.e. a typo / genuine code bug).
    await writeFile(
      path.join(migrationsDir, "2099_01_01_000_am2833_bad_import.ts"),
      "import 'nonexistent-package-am2833';\n" +
        "export async function up(): Promise<void> {}\n" +
        "export async function down(): Promise<void> {}\n",
    );

    process.env.AUTOMOBILE_DB_PATH = path.join(tempDir, "auto-mobile.db");
    process.env.AUTOMOBILE_MIGRATIONS_DIR = migrationsDir;

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    let db: Awaited<ReturnType<typeof harness.importFreshDatabaseModule>> | undefined;
    try {
      db = await harness.importFreshDatabaseModule();

      let thrown: unknown;
      try {
        await db.ensureMigrations();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      // Generic startup-migration failure, NOT the recoverable extraction remedy.
      expect((thrown as Error).message).toMatch(/refusing to run queries/i);
      expect(isIncompleteExtractionError(thrown)).toBe(false);
      expect((thrown as Error).message).not.toMatch(/incomplete package extraction/i);

      // Still sticky and generic on re-check.
      expect(isIncompleteExtractionError(db.getMigrationsError())).toBe(false);

      await defaultTimer.sleep(10);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await db?.closeDatabase();
    }
  });
});
