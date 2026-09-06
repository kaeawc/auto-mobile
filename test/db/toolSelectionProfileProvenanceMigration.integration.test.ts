import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { up, down } from "../../src/db/migrations/2026_09_06_000_tool_selection_profile_provenance";

/**
 * Migration coverage for #6225 (#6148/#6213 follow-up): the durable membership
 * set backing `PersistentToolSelectionProfileRegistry`.
 */
describe("2026_09_06_000_tool_selection_profile_provenance migration", () => {
  let db: Kysely<unknown>;

  beforeEach(() => {
    db = new Kysely<unknown>({
      dialect: new BunSqliteDialect({ database: new BunDatabase(":memory:") }),
    });
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function tableNames(): Promise<string[]> {
    const rows = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `.execute(db);
    return rows.rows.map((r) => r.name);
  }

  test("up() creates the provenance table", async () => {
    await up(db);
    expect(await tableNames()).toContain("tool_selection_profile_provenance");
  });

  test("up() is idempotent (ifNotExists, re-running does not throw)", async () => {
    await up(db);
    await up(db);
    expect(await tableNames()).toContain("tool_selection_profile_provenance");
  });

  test("profile_uuid is the primary key: a duplicate insert without ON CONFLICT throws", async () => {
    await up(db);
    await db
      .insertInto("tool_selection_profile_provenance" as any)
      .values({ profile_uuid: "minted-uuid" })
      .execute();
    await expect(
      db
        .insertInto("tool_selection_profile_provenance" as any)
        .values({ profile_uuid: "minted-uuid" })
        .execute(),
    ).rejects.toThrow();
  });

  test("created_at defaults to the current datetime", async () => {
    await up(db);
    await db
      .insertInto("tool_selection_profile_provenance" as any)
      .values({ profile_uuid: "minted-uuid" })
      .execute();
    const row = await db
      .selectFrom("tool_selection_profile_provenance" as any)
      .select(["created_at"])
      .executeTakeFirstOrThrow();
    expect(typeof (row as { created_at: string }).created_at).toBe("string");
    expect((row as { created_at: string }).created_at.length).toBeGreaterThan(0);
  });

  test("down() drops the provenance table", async () => {
    await up(db);
    await down(db);
    expect(await tableNames()).not.toContain("tool_selection_profile_provenance");
  });

  test("down() is idempotent (ifExists, re-running does not throw)", async () => {
    await up(db);
    await down(db);
    await down(db);
    expect(await tableNames()).not.toContain("tool_selection_profile_provenance");
  });
});
