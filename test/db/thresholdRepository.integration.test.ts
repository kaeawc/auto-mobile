import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { ThresholdRepository } from "../../src/db/thresholdRepository";
import type { Database, MemoryThresholds, NewMemoryThresholds } from "../../src/db/types";
import { createTestDatabase } from "./testDbHelper";

const BOUNDS = { min: 0.1, max: 10, successMultiplier: 1.1, failureMultiplier: 0.9 };

function row(overrides: Partial<NewMemoryThresholds> = {}): NewMemoryThresholds {
  return {
    device_id: "device-1",
    package_name: "com.example.app",
    heap_growth_threshold_mb: 10,
    native_heap_growth_threshold_mb: 20,
    gc_count_threshold: 1,
    gc_duration_threshold_ms: 100,
    unreachable_objects_threshold: 50,
    weight: 1,
    created_at: new Date().toISOString(),
    ttl_hours: 24,
    ...overrides,
  };
}

describe("ThresholdRepository", function () {
  let db: Kysely<Database>;
  const repo = new ThresholdRepository<MemoryThresholds>("memory_thresholds");
  const expiredAt = new Date(Date.now() - 48 * 3600 * 1000).toISOString();

  beforeEach(async function () {
    db = await createTestDatabase();
  });

  afterEach(async function () {
    await db.destroy();
  });

  test("insert then selectValid filters by where and excludes expired rows", async function () {
    await repo.insert(db, row());
    await repo.insert(db, row({ package_name: "com.other.app" }));
    await repo.insert(db, row({ created_at: expiredAt, ttl_hours: 1 }));

    const valid = await repo.selectValid(db, [
      { column: "device_id", value: "device-1" },
      { column: "package_name", value: "com.example.app" },
    ]);

    expect(valid).toHaveLength(1);
    expect(valid[0]).toMatchObject({ package_name: "com.example.app", ttl_hours: 24 });
  });

  test("selectValid returns newest first", async function () {
    const older = new Date(Date.now() - 3600 * 1000).toISOString();
    await repo.insert(db, row({ created_at: older, heap_growth_threshold_mb: 1 }));
    await repo.insert(db, row({ heap_growth_threshold_mb: 2 }));

    const valid = await repo.selectValid(db, []);

    expect(valid.map((r) => r.heap_growth_threshold_mb)).toEqual([2, 1]);
  });

  test("deleteExpired removes only expired matching rows and reports the count", async function () {
    await repo.insert(db, row({ created_at: expiredAt, ttl_hours: 1 }));
    await repo.insert(
      db,
      row({ package_name: "com.other.app", created_at: expiredAt, ttl_hours: 1 }),
    );
    await repo.insert(db, row());

    const deleted = await repo.deleteExpired(db, [
      { column: "package_name", value: "com.example.app" },
    ]);

    expect(deleted).toBe(1);
    expect(await db.selectFrom("memory_thresholds").select("package_name").execute()).toHaveLength(
      2,
    );
  });

  test("adjustLatestWeight scales only the newest valid matching row, clamped", async function () {
    const older = new Date(Date.now() - 3600 * 1000).toISOString();
    await repo.insert(db, row({ created_at: older, weight: 1 }));
    await repo.insert(db, row({ weight: 9.5 }));

    expect(await repo.adjustLatestWeight(db, [], true, BOUNDS)).toBe(1);
    expect(
      await repo.adjustLatestWeight(
        db,
        [{ column: "package_name", value: "missing" }],
        true,
        BOUNDS,
      ),
    ).toBe(0);

    const rows = await db
      .selectFrom("memory_thresholds")
      .select("weight")
      .orderBy("created_at")
      .execute();
    expect(rows.map((r) => r.weight)).toEqual([1, 10]);
  });
});
