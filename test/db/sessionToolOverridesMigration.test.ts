import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { up } from "../../src/db/migrations/2026_08_22_001_session_tool_overrides";

describe("session tool overrides migration", () => {
  let db: Kysely<unknown>;

  beforeEach(async () => {
    db = new Kysely<unknown>({
      dialect: new BunSqliteDialect({ database: new BunDatabase(":memory:") }),
    });
    await db.schema
      .createTable("session_tool_capabilities")
      .addColumn("session_uuid", "text", (column) => column.notNull())
      .addColumn("capability", "text", (column) => column.notNull())
      .addColumn("enabled", "integer", (column) => column.notNull())
      .addColumn("updated_at", "text", (column) => column.notNull())
      .execute();
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("expands persisted group choices into exact-tool rows and drops the old table", async () => {
    await db
      .insertInto("session_tool_capabilities" as any)
      .values([
        {
          session_uuid: "session-1",
          capability: "clipboard",
          enabled: 1,
          updated_at: "2026-08-01T00:00:00.000Z",
        },
        {
          session_uuid: "session-1",
          capability: "advanced-interaction",
          enabled: 0,
          updated_at: "2026-08-02T00:00:00.000Z",
        },
        {
          session_uuid: "session-1",
          capability: "device-control",
          enabled: 1,
          updated_at: "2026-08-03T00:00:00.000Z",
        },
      ])
      .execute();

    await up(db);

    const rows = await db
      .selectFrom("session_tool_overrides" as any)
      .select(["tool_name", "enabled"])
      .where("session_uuid", "=", "session-1")
      .orderBy("tool_name")
      .execute();
    expect(rows).toEqual([
      { tool_name: "clipboard", enabled: 1 },
      { tool_name: "deleteDevice", enabled: 1 },
      { tool_name: "dragAndDrop", enabled: 0 },
      { tool_name: "imeAction", enabled: 0 },
      { tool_name: "openLink", enabled: 0 },
      { tool_name: "pinchOn", enabled: 0 },
      { tool_name: "provisionDevice", enabled: 1 },
      { tool_name: "rotate", enabled: 0 },
      { tool_name: "selectAllText", enabled: 1 },
      { tool_name: "shake", enabled: 0 },
    ]);

    const oldTable = await sql<{ name: string }>`
      select name from sqlite_master
      where type = 'table' and name = 'session_tool_capabilities'
    `.execute(db);
    expect(oldTable.rows).toEqual([]);
  });
});
