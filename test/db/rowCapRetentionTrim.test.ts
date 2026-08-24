import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { createTestDatabase } from "./testDbHelper";
import type { Database } from "../../src/db/types";
import { pruneTableByRowCap } from "../../src/db/rowCapRetention";

/**
 * Direct coverage for `pruneTableByRowCap` — the shared "keep the newest N rows"
 * trim that carries the #3137 `id` tie-break invariant (rowCapRetention.ts:67-78).
 *
 * The regression this pins: a burst of rows written in the *same* millisecond
 * straddling the cutoff. Ordering by `timestamp` alone cannot separate them, so
 * without the `id` tie-break the delete leaves every same-instant row above the
 * cutoff in place — retaining more than the cap forever and making the trim
 * non-deterministic.
 */
describe("pruneTableByRowCap trim (#3137)", () => {
  let db: Kysely<Database>;

  const seedRow = async (timestamp: string): Promise<void> => {
    await db
      .insertInto("performance_audit_results")
      .values({
        device_id: "emulator-5554",
        session_id: "s1",
        package_name: "com.example",
        timestamp,
        passed: 1,
      })
      .execute();
  };

  const remainingIds = async (): Promise<number[]> => {
    const rows = await db
      .selectFrom("performance_audit_results")
      .select("id")
      .orderBy("id", "asc")
      .execute();
    return rows.map((r) => Number(r.id));
  };

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("returns zero and keeps every row when the table is at or under the cap", async () => {
    await seedRow("2026-01-01T00:00:00.000Z");
    await seedRow("2026-01-01T00:00:01.000Z");

    const deleted = await pruneTableByRowCap(db, "performance_audit_results", 5);

    expect(deleted).toBe(0);
    expect(await remainingIds()).toEqual([1, 2]);
  });

  test("keeps the newest rows by timestamp descending when over the cap", async () => {
    await seedRow("2026-01-01T00:00:00.000Z"); // id 1 (oldest)
    await seedRow("2026-01-01T00:00:01.000Z"); // id 2
    await seedRow("2026-01-01T00:00:02.000Z"); // id 3 (newest)

    const deleted = await pruneTableByRowCap(db, "performance_audit_results", 2);

    expect(deleted).toBe(1);
    expect(await remainingIds()).toEqual([2, 3]);
  });

  test("breaks a same-millisecond burst on id so the cap is exact when the cutoff lands inside the burst", async () => {
    // Two older rows, then a 4-row burst all stamped the same millisecond.
    await seedRow("2026-01-01T00:00:00.000Z"); // id 1
    await seedRow("2026-01-01T00:00:00.000Z"); // id 2
    await seedRow("2026-01-01T00:00:01.000Z"); // id 3  \
    await seedRow("2026-01-01T00:00:01.000Z"); // id 4   | same-ms burst
    await seedRow("2026-01-01T00:00:01.000Z"); // id 5   |
    await seedRow("2026-01-01T00:00:01.000Z"); // id 6  /

    // Cap 3 forces the cutoff to fall inside the burst (between id 3 and id 4).
    const deleted = await pruneTableByRowCap(db, "performance_audit_results", 3);

    // Without the id tie-break, the timestamp-only delete would leave all four
    // burst rows in place — retaining 4 > cap. The tie-break trims to exactly 3.
    expect(deleted).toBe(3);
    expect(await remainingIds()).toEqual([4, 5, 6]);
  });

  test("retains the single newest row when the cap is zero (SQLite clamps OFFSET -1 to 0)", async () => {
    await seedRow("2026-01-01T00:00:00.000Z"); // id 1
    await seedRow("2026-01-01T00:00:01.000Z"); // id 2 (newest)

    const deleted = await pruneTableByRowCap(db, "performance_audit_results", 0);

    // OFFSET maxRows-1 = -1 clamps to 0, so the threshold probe returns the
    // newest row and everything strictly older than it is deleted.
    expect(deleted).toBe(1);
    expect(await remainingIds()).toEqual([2]);
  });
});
