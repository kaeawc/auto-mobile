import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql, type Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { createTestBunDatabase, createTestDatabase } from "./testDbHelper";
import { recordStorageEvent } from "../../src/db/storageEventRepository";
import { pruneEventTableByCount } from "../../src/db/eventRetention";
import { createAmortizedRetentionState } from "../../src/db/retentionGate";
import { InstalledAppsRepository } from "../../src/db/installedAppsRepository";
import { DeviceLockRepository } from "../../src/db/deviceLockRepository";
import { createDeviceLockIdentityListener } from "../../src/devices/DeviceLockStore";

/**
 * Interaction pins for the db-writer branches merged together (#10042 BEGIN
 * IMMEDIATE, #10044 insertion-order retention, the storage previous-value index,
 * #10041 patch-only installed-apps upsert, #10065 device-lock identity). The app
 * connection serializes transactions on ONE handle, so a nested or deferred
 * transaction that now busy-waits would hang these (the test timeout is the
 * failure), and each read-then-write path must still produce correct data.
 */
describe("BEGIN IMMEDIATE with the read-then-write paths of the other db branches", () => {
  let db: Kysely<Database>;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db.deleteFrom("storage_events").execute();
    await db.deleteFrom("installed_apps").execute();
    await db.deleteFrom("device_locks").execute();
  });

  function storageEvent(value: string, timestamp: number) {
    return {
      deviceId: "dev-1",
      timestamp,
      applicationId: "com.example",
      sessionId: null,
      fileName: "prefs.xml",
      key: "k",
      value,
      valueType: "string",
      changeType: "modify",
    };
  }

  test("the full migration chain orders the 2026_10_05 migrations deterministically", async () => {
    const names = (
      await sql<{ name: string }>`SELECT name FROM kysely_migration ORDER BY name`.execute(db)
    ).rows.map((row) => row.name);
    const deviceLocks = names.indexOf("2026_10_05_000_device_locks_device_identity");
    const storage = names.indexOf("2026_10_05_001_storage_events_key_lookup_insertion_order");
    const edgeCoverage = names.indexOf("2026_10_05_002_test_edge_coverage_edge_id_index");
    expect(deviceLocks).toBeGreaterThan(-1);
    expect(storage).toBe(deviceLocks + 1);
    expect(edgeCoverage).toBe(storage + 1);
    const livenessRelease = names.indexOf("2026_10_05_003_device_session_liveness_release");
    expect(livenessRelease).toBe(edgeCoverage + 1);
    expect(livenessRelease).toBe(names.length - 1);

    const column = await sql<{ name: string }>`
      SELECT name FROM pragma_table_info('device_locks') WHERE name = 'device_identity'
    `.execute(db);
    expect(column.rows).toHaveLength(1);
    const index = await sql<{ name: string }>`
      SELECT name FROM pragma_index_list('storage_events') WHERE name = 'idx_storage_events_key_lookup_id'
    `.execute(db);
    expect(index.rows).toHaveLength(1);
  });

  test("concurrent storage inserts each read their predecessor inside their own immediate transaction", async () => {
    // Device clock is going BACKWARDS, so only insertion order can chain them.
    const events = Array.from({ length: 12 }, (_, i) => storageEvent(`v${i}`, 10_000 - i));
    await Promise.all(events.map((event) => recordStorageEvent(event, db)));

    const rows = await db
      .selectFrom("storage_events")
      .select(["value", "previous_value"])
      .orderBy("id", "asc")
      .execute();
    expect(rows.map((row) => row.previous_value)).toEqual([
      null,
      ...rows.slice(0, -1).map((row) => row.value),
    ]);
  });

  test("storage insert, device-lock forget, installed-apps patch and replace all complete together", async () => {
    const apps = new InstalledAppsRepository(db);
    const locks = new DeviceLockRepository(db);
    const listener = createDeviceLockIdentityListener(locks);
    await locks.rememberLock("emulator-5554", "pin", "1234", "avd-a");
    await apps.replaceInstalledApps("dev-1", []);

    const nowMs = 1_000;
    await Promise.all([
      recordStorageEvent(storageEvent("a", 5), db),
      recordStorageEvent(storageEvent("b", 4), db),
      apps.replaceInstalledApps("dev-1", [
        {
          device_id: "dev-1",
          user_id: 0,
          package_name: "com.a",
          is_system: 0,
          installed_at: nowMs,
          last_verified_at: nowMs,
        },
      ]),
      apps.upsertInstalledApp("dev-1", 0, "com.b", false, nowMs + 1),
      Promise.resolve(listener.onDeviceIdentityReplaced?.("emulator-5554")),
    ]);
    // The listener forgets with a detached promise; a following serialized write
    // on the same connection can only run after it.
    await recordStorageEvent(storageEvent("c", 3), db);

    expect(await locks.getCredential("emulator-5554", "avd-a")).toBeNull();
    const storage = await db.selectFrom("storage_events").select("previous_value").execute();
    expect(storage).toHaveLength(3);
    const packages = (await apps.listInstalledApps("dev-1")).map((app) => app.package_name);
    // The patch ran after the replace here (queue order), so both rows exist; it
    // never ran against the empty snapshot.
    expect(packages.sort()).toEqual(["com.a", "com.b"]);
  });

  test("a patch against a device with no snapshot writes nothing, even beside a transaction", async () => {
    const apps = new InstalledAppsRepository(db);
    await Promise.all([
      apps.upsertInstalledApp("dev-2", 0, "com.x", false, 1),
      recordStorageEvent(storageEvent("a", 1), db),
    ]);
    expect(await apps.listInstalledApps("dev-2")).toEqual([]);
  });

  test("retention by id keeps the newest inserted rows and the previous-value lookup follows them", async () => {
    const state = createAmortizedRetentionState();
    // 8 rows in insertion order; the device clock decreases, so by-timestamp
    // retention would have trimmed the newest rows instead.
    for (let i = 0; i < 8; i++) {
      await recordStorageEvent(storageEvent(`v${i}`, 9_000 - i), db);
    }
    await pruneEventTableByCount(db, "storage_events", state, 3, 1);

    const kept = await db
      .selectFrom("storage_events")
      .select("value")
      .orderBy("id", "asc")
      .execute();
    expect(kept.map((row) => row.value)).toEqual(["v5", "v6", "v7"]);

    await recordStorageEvent(storageEvent("v8", 1), db);
    const newest = await db
      .selectFrom("storage_events")
      .select(["value", "previous_value"])
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirstOrThrow();
    expect(newest).toEqual({ value: "v8", previous_value: "v7" });
  });
});

describe("storage previous-value lookup plan on the full migration chain", () => {
  test("with both key-lookup indexes present the ORDER BY id lookup seeks the id index with no sort", async () => {
    // The cloned template IS the full migration chain; re-running it per test cost ~27 ms.
    const bunDb = await createTestBunDatabase();
    try {
      // Raw handle: kysely's `sql` execute returns no rows for EXPLAIN QUERY PLAN.
      const detail = bunDb
        .query<{ detail: string }, []>(
          "EXPLAIN QUERY PLAN SELECT value FROM storage_events " +
            "WHERE device_id = 'd1' AND file_name = 'prefs.xml' AND key = 'k' " +
            "ORDER BY id DESC LIMIT 1",
        )
        .all()
        .map((row) => row.detail)
        .join("\n");
      expect(detail).toContain("idx_storage_events_key_lookup_id");
      expect(detail).not.toContain("USE TEMP B-TREE FOR ORDER BY");
    } finally {
      bunDb.close();
    }
  });
});
