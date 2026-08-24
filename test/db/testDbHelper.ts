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

export async function createTestDatabase(
  options: TestDatabaseOptions = {},
): Promise<Kysely<Database>> {
  const bunDb = new BunDatabase(":memory:");
  if (options.foreignKeys) {
    bunDb.exec("PRAGMA foreign_keys = ON;");
  }
  const db = new Kysely<Database>({
    dialect: new BunSqliteDialect({
      database: bunDb,
    }),
  });
  await runMigrations(db as Kysely<unknown>);
  return db;
}
