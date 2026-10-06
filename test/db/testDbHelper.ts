import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { FileMigrationProvider, type MigrationProvider } from "kysely/migration";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import type { Database } from "../../src/db/types";
import { resolveMigrationFolder, runMigrations } from "../../src/db/migrator";

export interface TestDatabaseOptions {
  /** Build an in-memory database at an earlier migration for upgrade tests. */
  throughMigration?: string;
  /**
   * Enable `PRAGMA foreign_keys = ON` so cascade deletes fire, matching the
   * production connection (`configureSqliteDatabase` in `src/db/database.ts`).
   * The default is OFF because that is bun:sqlite's default; opt in when a test
   * must exercise FK cascade behavior (e.g. the failure_groups de-dup migration,
   * where delete-before-repoint would cascade-wipe occurrences).
   */
  foreignKeys?: boolean;
}

const migratedTemplateBytesPromises = new Map<string | null, Promise<Uint8Array>>();

async function getMigratedTemplateBytes(throughMigration?: string): Promise<Uint8Array> {
  const cacheKey = throughMigration ?? null;
  let templateBytesPromise = migratedTemplateBytesPromises.get(cacheKey);
  if (!templateBytesPromise) {
    templateBytesPromise = (async () => {
      const bunDb = new BunDatabase(":memory:");
      const db = new Kysely<Database>({
        dialect: new BunSqliteDialect({ database: bunDb }),
      });
      try {
        let provider: MigrationProvider | undefined;
        if (throughMigration) {
          const source = new FileMigrationProvider({
            fs,
            path,
            migrationFolder: resolveMigrationFolder(),
          });
          const migrations = await source.getMigrations();
          if (!(throughMigration in migrations)) {
            throw new Error(`Unknown migration: ${throughMigration}`);
          }
          provider = {
            async getMigrations() {
              return Object.fromEntries(
                Object.entries(migrations).filter(([name]) => name <= throughMigration),
              );
            },
          };
        }
        await runMigrations(db as Kysely<unknown>, { provider });
        return bunDb.serialize();
      } finally {
        await db.destroy();
      }
    })();
    migratedTemplateBytesPromises.set(cacheKey, templateBytesPromise);
  }

  try {
    return await templateBytesPromise;
  } catch (error) {
    migratedTemplateBytesPromises.delete(cacheKey);
    throw error;
  }
}

// Build the default migrated template while the test file is being imported. The
// first `createTestDatabase()` in a file otherwise pays the whole one-time migration
// run inside its `beforeEach`, which the per-test timing budget counts against that
// file's first test (~60 ms locally, ~140 ms on a CI runner). Module load time is not
// part of any test's budget, and every later call clones these bytes.
await getMigratedTemplateBytes();

/**
 * Clone the migrated template into a raw bun:sqlite handle, for tests that need the
 * handle itself (e.g. `EXPLAIN QUERY PLAN`, which kysely's `sql` returns no rows
 * for). The caller owns the handle and must `close()` it.
 */
export async function createTestBunDatabase(
  options: TestDatabaseOptions = {},
): Promise<BunDatabase> {
  const templateBytes = await getMigratedTemplateBytes(options.throughMigration);
  // Give bun:sqlite a fresh copy in case its constructor takes ownership of the
  // supplied bytes. Every caller must get an independent in-memory database.
  const bunDb = new BunDatabase(new Uint8Array(templateBytes));
  if (options.foreignKeys) {
    bunDb.exec("PRAGMA foreign_keys = ON;");
  }
  return bunDb;
}

export async function createTestDatabase(
  options: TestDatabaseOptions = {},
): Promise<Kysely<Database>> {
  const bunDb = await createTestBunDatabase(options);
  const db = new Kysely<Database>({
    dialect: new BunSqliteDialect({
      database: bunDb,
    }),
  });
  // Initialize the driver's connection state so destroy() closes this cloned
  // database even when the caller has not run a query yet.
  await sql`select 1`.execute(db);
  return db;
}
