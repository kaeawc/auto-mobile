import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { AccessibilityBaselineRepository } from "../../src/db/accessibilityBaselineRepository";
import { createTestDatabase } from "./testDbHelper";

describe("AccessibilityBaselineRepository", () => {
  let db: Kysely<Database>;
  let repo: AccessibilityBaselineRepository;

  beforeEach(async () => {
    db = await createTestDatabase();
    repo = new AccessibilityBaselineRepository({ db });
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("upsert inserts then replaces by screen_id", async () => {
    await repo.upsert("home", "[1]", "2026-01-01T00:00:00.000Z");
    await repo.upsert("home", "[2]", "2026-01-02T00:00:00.000Z");
    const row = await repo.get("home");
    expect(row?.violations_json).toBe("[2]");
    expect(row?.updated_at).toBe("2026-01-02T00:00:00.000Z");
    expect(await repo.list()).toHaveLength(1);
  });

  test("get returns null for a missing screen", async () => {
    expect(await repo.get("nope")).toBeNull();
  });

  test("delete and deleteAll remove rows", async () => {
    await repo.upsert("a", "[]", "2026-01-01T00:00:00.000Z");
    await repo.upsert("b", "[]", "2026-01-01T00:00:00.000Z");
    await repo.delete("a");
    expect((await repo.list()).map((r) => r.screen_id)).toEqual(["b"]);
    await repo.deleteAll();
    expect(await repo.list()).toEqual([]);
  });

  test("deleteOlderThan compares instants, not strings, and returns the count", async () => {
    await repo.upsert("old", "[]", "2026-01-01T00:00:00.000Z");
    await repo.upsert("new", "[]", "2026-03-01T00:00:00.000Z");
    // SQLite-format value with a space sorts before 'T' lexically; same-day but newer.
    await db
      .updateTable("accessibility_baselines")
      .set({ updated_at: "2026-02-01 12:00:00" })
      .where("screen_id", "=", "new")
      .execute();
    const deleted = await repo.deleteOlderThan("2026-02-01T00:00:00.000Z");
    expect(deleted).toBe(1);
    expect((await repo.list()).map((r) => r.screen_id)).toEqual(["new"]);
  });
});
