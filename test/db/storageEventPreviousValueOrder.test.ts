import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { up as storageUp } from "../../src/db/migrations/2026_03_19_000_storage_events";
import { up as previousValueUp } from "../../src/db/migrations/2026_03_19_002_storage_events_previous_value";
import { up as keyLookupUp } from "../../src/db/migrations/2026_07_04_000_storage_events_key_lookup";
import {
  up as insertionOrderUp,
  down as insertionOrderDown,
} from "../../src/db/migrations/2026_10_05_000_storage_events_key_lookup_insertion_order";
import type { Database } from "../../src/db/types";
import { recordStorageEvent, getStorageEvents } from "../../src/db/storageEventRepository";
import { createTestDatabase } from "./testDbHelper";

function event(timestamp: number, value: string, key = "theme", deviceId = "d1") {
  return {
    deviceId,
    timestamp,
    applicationId: null,
    sessionId: null,
    fileName: "prefs.xml",
    key,
    value,
    valueType: null,
    changeType: "modify" as const,
  };
}

describe("storage event previous-value lookup follows insertion order", () => {
  let db: Kysely<Database>;
  beforeEach(async () => {
    db = await createTestDatabase();
  });
  afterEach(async () => {
    await db.destroy();
  });

  async function previousValueOf(value: string): Promise<string | null | undefined> {
    const rows = await db
      .selectFrom("storage_events")
      .select("previous_value")
      .where("value", "=", value)
      .execute();
    return rows[0]?.previous_value;
  }

  test("a device clock that goes backwards still records the last stored value as previous", async () => {
    await recordStorageEvent(event(5000, "first"), db);
    // Clock reset: later rows carry smaller timestamps than earlier ones.
    await recordStorageEvent(event(1000, "second"), db);
    await recordStorageEvent(event(500, "third"), db);

    expect(await previousValueOf("first")).toBeNull();
    expect(await previousValueOf("second")).toBe("first");
    // By timestamp the newest row is "first"; by insertion it is "second".
    expect(await previousValueOf("third")).toBe("second");
  });

  test("monotonic timestamps still resolve to the last stored value", async () => {
    await recordStorageEvent(event(1000, "a"), db);
    await recordStorageEvent(event(2000, "b"), db);
    await recordStorageEvent(event(3000, "c"), db);

    expect(await previousValueOf("b")).toBe("a");
    expect(await previousValueOf("c")).toBe("b");
  });

  test("the lookup stays scoped to device, file and key", async () => {
    await recordStorageEvent(event(5000, "other-key", "other"), db);
    await recordStorageEvent(event(4000, "other-device", "theme", "d2"), db);
    await recordStorageEvent(event(1000, "mine"), db);

    expect(await previousValueOf("mine")).toBeNull();
    const events = await getStorageEvents({ deviceId: "d1", limit: 10 }, db);
    expect(events.map((e) => e.value).sort()).toEqual(["mine", "other-key"]);
  });

  test("an explicit previousValue still wins over the lookup", async () => {
    await recordStorageEvent(event(5000, "first"), db);
    await recordStorageEvent({ ...event(1000, "second"), previousValue: null }, db);

    expect(await previousValueOf("second")).toBeNull();
  });
});

describe("2026_10_05_000_storage_events_key_lookup_insertion_order migration", () => {
  let bunDb: BunDatabase;
  let db: Kysely<unknown>;

  beforeEach(async () => {
    bunDb = new BunDatabase(":memory:");
    db = new Kysely<unknown>({ dialect: new BunSqliteDialect({ database: bunDb }) });
    await storageUp(db);
    await previousValueUp(db);
    await keyLookupUp(db);
    // Production dropped this standalone index (2026_07_03 drop_redundant_device_indexes).
    bunDb.run("DROP INDEX IF EXISTS idx_storage_events_device");
  });
  afterEach(async () => {
    await db.destroy();
  });

  // Raw handle: kysely's `sql` execute returns no rows for EXPLAIN QUERY PLAN.
  function lookupPlan(): string {
    return bunDb
      .query<{ detail: string }, []>(
        "EXPLAIN QUERY PLAN SELECT value FROM storage_events " +
          "WHERE device_id = 'd1' AND file_name = 'prefs.xml' AND key = 'theme' " +
          "ORDER BY id DESC LIMIT 1",
      )
      .all()
      .map((r) => r.detail)
      .join("\n");
  }

  test("without the index the insertion-order lookup needs a temp B-tree sort", () => {
    expect(lookupPlan()).toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  test("with the index the lookup seeks the key prefix and skips the sort", async () => {
    await insertionOrderUp(db);
    const plan = lookupPlan();
    expect(plan).toContain("idx_storage_events_key_lookup_id");
    expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  test("up is idempotent and down removes only the new index", async () => {
    await insertionOrderUp(db);
    await insertionOrderUp(db);
    await insertionOrderDown(db);
    await insertionOrderDown(db);
    const names = bunDb
      .query<{ name: string }, []>("SELECT name FROM pragma_index_list('storage_events')")
      .all()
      .map((r) => r.name);
    expect(names).toContain("idx_storage_events_key_lookup");
    expect(names).not.toContain("idx_storage_events_key_lookup_id");
  });
});
