import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { up as createFlags } from "../../src/db/migrations/2026_01_03_000_feature_flags";
import { up, down } from "../../src/db/migrations/2026_11_04_000_tool_call_recording_default_on";

describe("tool-call-recording default-on migration", () => {
  let bunDb: BunDatabase;
  let db: Kysely<unknown>;

  beforeEach(async () => {
    bunDb = new BunDatabase(":memory:");
    db = new Kysely<unknown>({ dialect: new BunSqliteDialect({ database: bunDb }) });
    await createFlags(db);
    await sql`INSERT INTO feature_flags (key, enabled, config_json, created_at, updated_at)
      VALUES ('tool-call-recording', 0, NULL, 'created', 'updated'),
             ('debug', 0, NULL, 'created-debug', 'updated-debug')`.execute(db);
  });
  afterEach(async () => {
    await db.destroy();
  });

  const enabledByKey = () =>
    bunDb.query("SELECT key, enabled FROM feature_flags ORDER BY key").all();

  test("up turns the persisted old default on and leaves other flags alone", async () => {
    await up(db);
    expect(enabledByKey()).toEqual([
      { key: "debug", enabled: 0 },
      { key: "tool-call-recording", enabled: 1 },
    ]);
  });

  test("down restores the flag to off", async () => {
    await up(db);
    await down(db);
    expect(enabledByKey()).toEqual([
      { key: "debug", enabled: 0 },
      { key: "tool-call-recording", enabled: 0 },
    ]);
  });
});
