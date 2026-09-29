import { Database as BunDatabase } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import type { Database } from "../../src/db/types";
import { runMigrations } from "../../src/db/migrator";

export interface TestDatabaseOptions {
  /**
   * Enable `PRAGMA foreign_keys = ON` so cascade deletes fire, matching the
   * production connection (`configureSqliteDatabase` in `src/db/database.ts`).
   * The default is OFF because that is bun:sqlite's default; opt in when a test
   * must exercise FK cascade behavior (e.g. the failure_groups de-dup migration,
   * where delete-before-repoint would cascade-wipe occurrences).
   */
  foreignKeys?: boolean;
}

let migratedTemplateBytesPromise: Promise<Uint8Array> | null = null;

async function getMigratedTemplateBytes(): Promise<Uint8Array> {
  if (!migratedTemplateBytesPromise) {
    migratedTemplateBytesPromise = (async () => {
      const bunDb = new BunDatabase(":memory:");
      const db = new Kysely<Database>({
        dialect: new BunSqliteDialect({ database: bunDb }),
      });
      try {
        await runMigrations(db as Kysely<unknown>);
        return bunDb.serialize();
      } finally {
        await db.destroy();
      }
    })();
  }

  try {
    return await migratedTemplateBytesPromise;
  } catch (error) {
    migratedTemplateBytesPromise = null;
    throw error;
  }
}

export async function createTestDatabase(
  options: TestDatabaseOptions = {},
): Promise<Kysely<Database>> {
  const templateBytes = await getMigratedTemplateBytes();
  // Give bun:sqlite a fresh copy in case its constructor takes ownership of the
  // supplied bytes. Every caller must get an independent in-memory database.
  const bunDb = new BunDatabase(new Uint8Array(templateBytes));
  if (options.foreignKeys) {
    bunDb.exec("PRAGMA foreign_keys = ON;");
  }
  return new Kysely<Database>({
    dialect: new BunSqliteDialect({
      database: bunDb,
    }),
  });
}
