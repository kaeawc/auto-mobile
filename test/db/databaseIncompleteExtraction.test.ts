import { afterEach, describe, expect, test } from "bun:test";
import path from "path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { isIncompleteExtractionError } from "../../src/db/migrationDependencyIntegrity";

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
  const originalDbPath = process.env.AUTOMOBILE_DB_PATH;
  const originalMigrationsDir = process.env.AUTOMOBILE_MIGRATIONS_DIR;
  let tempDir: string | undefined;

  function restore(key: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  afterEach(async () => {
    restore("AUTOMOBILE_DB_PATH", originalDbPath);
    restore("AUTOMOBILE_MIGRATIONS_DIR", originalMigrationsDir);
    if (tempDir) {
      await removeTempDirWithRetry(tempDir);
      tempDir = undefined;
    }
  });

  async function importFreshDatabaseModule() {
    return import(`../../src/db/database.ts?incomplete-extraction-test=${Date.now()}-${Math.random()}`);
  }

  // Windows holds the sqlite file until the handle is fully released; retry the
  // removal past a transient EBUSY/EPERM rather than failing the test on cleanup.
  async function removeTempDirWithRetry(dir: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await rm(dir, { recursive: true, force: true });
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") {
          throw error;
        }
        await defaultTimer.sleep(50);
      }
    }
    await rm(dir, { recursive: true, force: true });
  }

  test("an unknown missing package surfaces the generic error, not incomplete-extraction", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "am-bad-import-"));
    const migrationsDir = path.join(tempDir, "migrations");
    await mkdir(migrationsDir, { recursive: true });

    // A migration whose runtime value import cannot be resolved and is NOT a
    // declared migration dependency (i.e. a typo / genuine code bug).
    await writeFile(
      path.join(migrationsDir, "2099_01_01_000_am2833_bad_import.ts"),
      "import 'nonexistent-package-am2833';\n" +
        "export async function up(): Promise<void> {}\n" +
        "export async function down(): Promise<void> {}\n"
    );

    process.env.AUTOMOBILE_DB_PATH = path.join(tempDir, "auto-mobile.db");
    process.env.AUTOMOBILE_MIGRATIONS_DIR = migrationsDir;

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    let db: Awaited<ReturnType<typeof importFreshDatabaseModule>> | undefined;
    try {
      db = await importFreshDatabaseModule();

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
