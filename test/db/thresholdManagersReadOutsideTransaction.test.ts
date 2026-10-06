import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { MemoryThresholdManager } from "../../src/features/memory/MemoryThresholdManager";
import { ThresholdManager } from "../../src/features/performance/ThresholdManager";
import type { DeviceCapabilities } from "../../src/utils/DeviceCapabilities";
import { createTestDatabase } from "./testDbHelper";

/**
 * Every transaction is `BEGIN IMMEDIATE` and takes the writer lock (#10042), so a
 * get-or-create whose common path only reads must not open one: it would wait
 * behind a peer daemon's writer for nothing. The transaction is opened only when
 * a row must be created, and the check is repeated inside it.
 */
describe("getOrCreateThresholds opens a transaction only to create", () => {
  let db: Kysely<Database>;
  const capabilities: DeviceCapabilities = { refreshRate: 60, frameTimeMs: 1000 / 60 };

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db.deleteFrom("performance_thresholds").execute();
    await db.deleteFrom("memory_thresholds").execute();
  });

  function transactionSpy() {
    return spyOn(db, "transaction");
  }

  test("performance: a creating call uses one transaction, later calls use none", async () => {
    const manager = new ThresholdManager(db);
    const spy = transactionSpy();

    const created = await manager.getOrCreateThresholds("device-1", capabilities);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await db.selectFrom("performance_thresholds").selectAll().execute()).toHaveLength(1);

    const reused = await manager.getOrCreateThresholds("device-1", capabilities);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(reused.frameTimeThresholdMs).toBe(created.frameTimeThresholdMs);
    spy.mockRestore();
  });

  test("performance: a racing creator re-checks inside the transaction and stores one row", async () => {
    const manager = new ThresholdManager(db);

    await Promise.all([
      manager.getOrCreateThresholds("device-1", capabilities),
      manager.getOrCreateThresholds("device-1", capabilities),
      manager.getOrCreateThresholds("device-1", capabilities),
    ]);

    expect(await db.selectFrom("performance_thresholds").selectAll().execute()).toHaveLength(1);
  });

  test("memory: a creating call uses one transaction, later calls use none", async () => {
    const manager = new MemoryThresholdManager(db);
    const spy = transactionSpy();

    const created = await manager.getOrCreateThresholds("device-1", "com.example.app");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await db.selectFrom("memory_thresholds").selectAll().execute()).toHaveLength(1);

    const reused = await manager.getOrCreateThresholds("device-1", "com.example.app");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(reused.heapGrowthThresholdMb).toBe(created.heapGrowthThresholdMb);
    spy.mockRestore();
  });

  test("memory: a racing creator re-checks inside the transaction and stores one row", async () => {
    const manager = new MemoryThresholdManager(db);

    await Promise.all([
      manager.getOrCreateThresholds("device-1", "com.example.app"),
      manager.getOrCreateThresholds("device-1", "com.example.app"),
      manager.getOrCreateThresholds("device-1", "com.example.app"),
    ]);

    expect(await db.selectFrom("memory_thresholds").selectAll().execute()).toHaveLength(1);
  });
});
