import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { MemoryBaselineRepository } from "../../src/db/memoryBaselineRepository";
import { createTestDatabase } from "./testDbHelper";

describe("MemoryBaselineRepository", () => {
  let db: Kysely<Database>;
  let repo: MemoryBaselineRepository;

  const sample = {
    deviceId: "dev",
    packageName: "com.example",
    toolName: "tapOn",
    javaHeapMb: 100,
    nativeHeapMb: 50,
    gcCount: 10,
    gcDurationMs: 20,
    unreachableObjects: 4,
    alpha: 0.5,
    now: "2026-01-01T00:00:00.000Z",
  };

  beforeEach(async () => {
    db = await createTestDatabase();
    repo = new MemoryBaselineRepository({ db });
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("upsertEma inserts the first sample verbatim", async () => {
    await repo.upsertEma(sample);
    const row = await repo.get("dev", "com.example", "tapOn");
    expect(row?.java_heap_baseline_mb).toBe(100);
    expect(row?.sample_count).toBe(1);
  });

  test("upsertEma folds later samples with an EMA and bumps sample_count", async () => {
    await repo.upsertEma(sample);
    await repo.upsertEma({ ...sample, javaHeapMb: 200, now: "2026-01-02T00:00:00.000Z" });
    const row = await repo.get("dev", "com.example", "tapOn");
    expect(row?.java_heap_baseline_mb).toBe(150);
    expect(row?.sample_count).toBe(2);
    expect(row?.last_updated).toBe("2026-01-02T00:00:00.000Z");
  });

  test("get returns null when absent and listForPackage spans tools", async () => {
    expect(await repo.get("dev", "com.example", "tapOn")).toBeNull();
    await repo.upsertEma(sample);
    await repo.upsertEma({ ...sample, toolName: "swipeOn" });
    await repo.upsertEma({ ...sample, packageName: "other" });
    expect(await repo.listForPackage("dev", "com.example")).toHaveLength(2);
  });

  test("deleteOlderThan removes only stale rows and returns the count", async () => {
    await repo.upsertEma({ ...sample, now: "2026-01-01T00:00:00.000Z" });
    await repo.upsertEma({ ...sample, toolName: "swipeOn", now: "2026-03-01T00:00:00.000Z" });
    expect(await repo.deleteOlderThan("2026-02-01T00:00:00.000Z")).toBe(1);
    expect(await repo.listForPackage("dev", "com.example")).toHaveLength(1);
  });
});
