import { afterEach, describe, expect, test } from "bun:test";
import path from "path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { defaultTimer } from "../../src/utils/SystemTimer";
import {
  INCOMPLETE_EXTRACTION_CODE,
  isIncompleteExtractionError,
} from "../../src/db/migrationDependencyIntegrity";

/**
 * Issue #2833: when a migration cannot resolve a runtime dependency (the
 * signature of a half-linked `bunx` extraction), the startup migration failure
 * surfaced to the daemon must be the distinct, recoverable incomplete-extraction
 * error — not the generic "refusing to run queries" crash.
 *
 * This drives the REAL migrator path: a temp migrations folder whose only
 * migration imports a package that does not exist, so bun throws a genuine
 * "Cannot find package" resolve error while loading the migration file. That
 * mirrors the missing-`kysely` failure and proves the mapping holds even when
 * the cheap preflight is bypassed.
 */
describe("startup migration failure maps a missing dependency to a recoverable error", () => {
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
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  async function importFreshDatabaseModule() {
    return import(`../../src/db/database.ts?incomplete-extraction-test=${Date.now()}-${Math.random()}`);
  }

  test("ensureMigrations rejects with the recoverable incomplete-extraction error", async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "am-incomplete-extraction-"));
    const migrationsDir = path.join(tempDir, "migrations");
    await mkdir(migrationsDir, { recursive: true });

    // A migration whose runtime value import cannot be resolved.
    await writeFile(
      path.join(migrationsDir, "2099_01_01_000_am2833_missing_dep.ts"),
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

    try {
      const db = await importFreshDatabaseModule();

      let thrown: unknown;
      try {
        await db.ensureMigrations();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(isIncompleteExtractionError(thrown)).toBe(true);
      expect((thrown as { code?: string }).code).toBe(INCOMPLETE_EXTRACTION_CODE);
      expect((thrown as Error).message).toMatch(/incomplete/i);
      expect((thrown as Error).message).toMatch(/re-?run/i);
      // Not the generic startup-migration message.
      expect((thrown as Error).message).not.toMatch(/refusing to run queries/i);

      // The cached error stays sticky and recoverable-typed on re-check.
      expect(isIncompleteExtractionError(db.getMigrationsError())).toBe(true);

      await defaultTimer.sleep(10);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
