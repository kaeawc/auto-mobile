import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { existsSync, mkdtempSync, readdirSync } from "fs";
import * as os from "os";
import * as path from "path";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { backupDatabaseFile } from "../../src/db/database";
import { ActionableError } from "../../src/models/ActionableError";
import { removeTempDbDirSync } from "./tempDbDir";

describe("backupDatabaseFile", () => {
  let dir: string;
  let dbPath: string;
  let raw: BunDatabase;
  let db: Kysely<unknown>;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "am-backup-"));
    dbPath = path.join(dir, "auto-mobile.db");
    raw = new BunDatabase(dbPath);
    raw.exec("PRAGMA journal_mode = WAL;");
    db = new Kysely<unknown>({ dialect: new BunSqliteDialect({ database: raw }) });
  });

  afterEach(async () => {
    await db.destroy();
    removeTempDbDirSync(dir);
  });

  test("captures uncheckpointed WAL rows into a timestamped backup file", async () => {
    await sql`create table widgets (id integer primary key, label text)`.execute(db);
    // Write rows that may still be sitting in the -wal file (not yet checkpointed).
    await sql`insert into widgets (id, label) values (42, 'sentinel')`.execute(db);

    await backupDatabaseFile(db, dbPath);

    // VACUUM INTO writes exactly one snapshot file — no -wal/-shm sidecars.
    const backups = readdirSync(dir).filter((f) => f.includes(".corrupt-backup-"));
    expect(backups.length).toBe(1);
    expect(backups[0]).toContain(String(process.pid));

    // The backup must contain the row even though it may still be in the -wal —
    // VACUUM INTO snapshots through the connection, which is what makes it WAL-safe.
    const backupDb = new BunDatabase(path.join(dir, backups[0]));
    const row = backupDb.query("select label from widgets where id = 42").get() as {
      label: string;
    } | null;
    expect(row?.label).toBe("sentinel");
    backupDb.close();
  });

  test("wraps failures in an ActionableError", async () => {
    await sql`create table widgets (id integer primary key)`.execute(db);
    const missingPath = path.join(dir, "does-not-exist", "auto-mobile.db");

    let thrown: unknown;
    try {
      await backupDatabaseFile(db, missingPath);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ActionableError);
    expect(existsSync(missingPath)).toBe(false);
  });
});
