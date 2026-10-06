import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { createTestDatabase } from "./testDbHelper";
import type { Database } from "../../src/db/types";
import { pruneEventTableByCount } from "../../src/db/eventRetention";
import {
  pruneTableByInsertionOrder,
  pruneTableByRowCap,
  type RowCapTable,
} from "../../src/db/rowCapRetention";
import { createAmortizedRetentionState } from "../../src/db/retentionGate";
import {
  cleanupIfNeeded as cleanupNetwork,
  getNetworkEvents,
  recordNetworkEvent,
  type RecordNetworkEventInput,
} from "../../src/db/networkEventRepository";

/**
 * Row-cap retention keeps the most recently STORED rows (by autoincrement `id`),
 * not the newest by a device-supplied `timestamp` (#10044). A device whose clock
 * is behind the stored rows (emulator snapshot restore, host sleep) must not have
 * the events it just sent pruned in preference to rows stored long before.
 */
describe("retention keeps the most recently inserted rows (#10044)", () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  afterEach(async () => {
    await db.destroy();
  });

  const networkEvent = (deviceId: string, timestamp: number): RecordNetworkEventInput => ({
    deviceId,
    timestamp,
    applicationId: null,
    sessionId: null,
    url: "https://example.test/a",
    method: "GET",
    statusCode: 200,
    durationMs: 1,
    requestBodySize: 0,
    responseBodySize: 0,
    protocol: null,
    host: null,
    path: null,
    error: null,
  });

  const networkTimestamps = async (): Promise<number[]> => {
    const rows = await db
      .selectFrom("network_events")
      .select("timestamp")
      .orderBy("id", "asc")
      .execute();
    return rows.map((r) => Number(r.timestamp));
  };

  test("network_events: a just-inserted event with an old device timestamp survives; the oldest-inserted row is pruned", async () => {
    await recordNetworkEvent(networkEvent("B", 1000), db);
    await recordNetworkEvent(networkEvent("B", 1001), db);
    await recordNetworkEvent(networkEvent("B", 1002), db);
    // Device A's clock is far behind the stored rows.
    await recordNetworkEvent(networkEvent("A", 10), db);

    await cleanupNetwork(db, 3, 1);

    // Oldest-inserted (timestamp 1000) is gone; the lagging device's row remains.
    expect(await networkTimestamps()).toEqual([1001, 1002, 10]);
    expect(await getNetworkEvents({ deviceId: "A" }, db)).toHaveLength(1);
  });

  test("network_events: a burst from a lagging device never displaces newer-stored rows beyond the cap", async () => {
    for (let i = 0; i < 3; i++) {
      await recordNetworkEvent(networkEvent("B", 5000 + i), db);
    }
    for (let i = 0; i < 3; i++) {
      await recordNetworkEvent(networkEvent("A", i), db);
    }

    await cleanupNetwork(db, 3, 1);

    // Exactly the cap, all of them the most recently stored.
    expect(await networkTimestamps()).toEqual([0, 1, 2]);
  });

  test("pruneEventTableByCount trims log_events by id, ignoring timestamp order", async () => {
    const insert = (timestamp: number) =>
      db
        .insertInto("log_events")
        .values({
          device_id: "d",
          timestamp,
          application_id: null,
          session_id: null,
          level: 3,
          tag: "T",
          message: "m",
          filter_name: "f",
        })
        .execute();
    for (const ts of [900, 800, 700, 5, 4]) {
      await insert(ts);
    }

    await pruneEventTableByCount(db, "log_events", createAmortizedRetentionState(), 3, 1);

    const rows = await db
      .selectFrom("log_events")
      .select("timestamp")
      .orderBy("id", "asc")
      .execute();
    expect(rows.map((r) => Number(r.timestamp))).toEqual([700, 5, 4]);
  });

  test("pruneTableByInsertionOrder returns the deleted count and is a no-op at or under the cap", async () => {
    for (const ts of [30, 20, 10, 1]) {
      await recordNetworkEvent(networkEvent("d", ts), db);
    }

    expect(await pruneTableByInsertionOrder(db, "network_events", 4)).toBe(0);
    expect(await pruneTableByInsertionOrder(db, "network_events", 2)).toBe(2);
    expect(await networkTimestamps()).toEqual([10, 1]);
  });

  describe("RowCapTable device-stamped tables (crashes, anrs)", () => {
    const insertCrash = (timestamp: number) =>
      db
        .insertInto("crashes")
        .values({
          device_id: "d",
          package_name: "com.example",
          crash_type: "java",
          timestamp,
          detection_source: "logcat",
        })
        .execute();

    const insertAnr = (timestamp: number) =>
      db
        .insertInto("anrs")
        .values({
          device_id: "d",
          package_name: "com.example",
          timestamp,
          detection_source: "logcat",
        })
        .execute();

    const timestampsOf = async (table: "crashes" | "anrs"): Promise<number[]> => {
      const rows = await db.selectFrom(table).select("timestamp").orderBy("id", "asc").execute();
      return rows.map((r) => Number(r.timestamp));
    };

    test("crashes: keeps the most recently inserted rows even when their timestamps are older", async () => {
      for (const ts of [1000, 1001, 1002, 10]) {
        await insertCrash(ts);
      }

      expect(await pruneTableByRowCap(db, "crashes", 3)).toBe(1);
      expect(await timestampsOf("crashes")).toEqual([1001, 1002, 10]);
    });

    test("anrs: keeps the most recently inserted rows even when their timestamps are older", async () => {
      for (const ts of [1000, 1001, 1002, 10]) {
        await insertAnr(ts);
      }

      expect(await pruneTableByRowCap(db, "anrs", 3)).toBe(1);
      expect(await timestampsOf("anrs")).toEqual([1001, 1002, 10]);
    });
  });

  test("daemon-stamped tables keep timestamp ordering (unchanged)", async () => {
    const table: RowCapTable = "performance_audit_results";
    for (const timestamp of [
      "2026-01-01T00:00:02.000Z",
      "2026-01-01T00:00:03.000Z",
      "2026-01-01T00:00:01.000Z",
    ]) {
      await db
        .insertInto(table)
        .values({
          device_id: "d",
          session_id: "s",
          package_name: "com.example",
          timestamp,
          passed: 1,
        })
        .execute();
    }

    expect(await pruneTableByRowCap(db, table, 2)).toBe(1);

    const rows = await db
      .selectFrom(table)
      .select("timestamp")
      .orderBy("timestamp", "asc")
      .execute();
    expect(rows.map((r) => r.timestamp)).toEqual([
      "2026-01-01T00:00:02.000Z",
      "2026-01-01T00:00:03.000Z",
    ]);
  });
});
