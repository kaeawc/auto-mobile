import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "./testDbHelper";
import { up as repairUp } from "../../src/db/migrations/2026_07_03_000_repair_datetime_now_defaults";

/**
 * Coverage for the data-repair half of issue #2895. Historical databases that
 * ran the buggy `defaultTo("datetime('now')")` DDL already stored the literal
 * text `datetime('now')` in defaulted timestamp columns. The forward DDL fix
 * only helps freshly-created columns; this repair migration rewrites the
 * poisoned rows in place.
 *
 * The repair must be:
 *   - Complete: any text column holding the literal string is healed, regardless
 *     of table.
 *   - Safe: legitimate app-supplied timestamps are left untouched (the WHERE
 *     predicate matches only the exact literal).
 *   - Idempotent + no-op on clean data (survives the destructive-recovery replay
 *     that drops every table and re-runs all migrations on a fresh schema).
 */
describe("2026_07_03_000_repair_datetime_now_defaults migration (#2895)", () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("rewrites literal datetime('now') rows to a real timestamp", async () => {
    // Seed a poisoned row exactly as the buggy default would have.
    await db
      .insertInto("navigation_apps")
      .values({
        app_id: "poisoned",
        created_at: "datetime('now')",
        updated_at: "2026-07-03T00:00:00.000Z",
      })
      .execute();

    await repairUp(db as unknown as Kysely<unknown>);

    const row = await db
      .selectFrom("navigation_apps")
      .selectAll()
      .where("app_id", "=", "poisoned")
      .executeTakeFirstOrThrow();

    expect(row.created_at).not.toBe("datetime('now')");
    expect(Number.isNaN(Date.parse(row.created_at))).toBe(false);
  });

  test("leaves legitimate timestamps untouched", async () => {
    await db
      .insertInto("navigation_apps")
      .values({
        app_id: "legit",
        created_at: "2026-01-01T12:34:56.000Z",
        updated_at: "2026-01-01T12:34:56.000Z",
      })
      .execute();

    await repairUp(db as unknown as Kysely<unknown>);

    const row = await db
      .selectFrom("navigation_apps")
      .selectAll()
      .where("app_id", "=", "legit")
      .executeTakeFirstOrThrow();

    expect(row.created_at).toBe("2026-01-01T12:34:56.000Z");
  });

  test("is idempotent and a no-op on already-clean data", async () => {
    await db
      .insertInto("navigation_apps")
      .values({
        app_id: "poisoned",
        created_at: "datetime('now')",
        updated_at: "2026-07-03T00:00:00.000Z",
      })
      .execute();

    await repairUp(db as unknown as Kysely<unknown>);
    const firstPass = await db
      .selectFrom("navigation_apps")
      .selectAll()
      .where("app_id", "=", "poisoned")
      .executeTakeFirstOrThrow();

    // Running again must not throw and must not re-touch the already-fixed value.
    await repairUp(db as unknown as Kysely<unknown>);
    const secondPass = await db
      .selectFrom("navigation_apps")
      .selectAll()
      .where("app_id", "=", "poisoned")
      .executeTakeFirstOrThrow();

    expect(secondPass.created_at).toBe(firstPass.created_at);
  });
});
