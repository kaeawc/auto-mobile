import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import type { Database } from "../../src/db/types";
import { runMigrations } from "../../src/db/migrator";
import { createTestDatabase } from "./testDbHelper";
import { recordStorageEvent, getStorageEvents } from "../../src/db/storageEventRepository";

describe("StorageEventRepository", () => {
  let db: Kysely<Database>;
  beforeEach(async () => {
    db = await createTestDatabase();
  });
  afterEach(async () => {
    await db.destroy();
  });

  test("recordStorageEvent inserts and retrieves", async () => {
    await recordStorageEvent(
      {
        deviceId: "d1",
        timestamp: 1000,
        applicationId: "com.example",
        sessionId: "s1",
        fileName: "prefs.xml",
        key: "dark_mode",
        value: "true",
        valueType: "BOOLEAN",
        changeType: "modify",
      },
      db,
    );
    const events = await getStorageEvents({ deviceId: "d1" }, db);
    expect(events).toHaveLength(1);
    expect(events[0].fileName).toBe("prefs.xml");
    expect(events[0].key).toBe("dark_mode");
    expect(events[0].value).toBe("true");
    expect(events[0].changeType).toBe("modify");
  });

  test("recordStorageEvent looks up previous value from prior event", async () => {
    await recordStorageEvent(
      {
        deviceId: "d1",
        timestamp: 1000,
        applicationId: null,
        sessionId: null,
        fileName: "prefs.xml",
        key: "theme",
        value: "light",
        valueType: "STRING",
        changeType: "add",
      },
      db,
    );
    await recordStorageEvent(
      {
        deviceId: "d1",
        timestamp: 2000,
        applicationId: null,
        sessionId: null,
        fileName: "prefs.xml",
        key: "theme",
        value: "dark",
        valueType: "STRING",
        changeType: "modify",
      },
      db,
    );
    const events = await getStorageEvents({ deviceId: "d1" }, db);
    // Most recent first
    expect(events[0].previousValue).toBe("light");
  });

  test("recordStorageEvent uses provided previousValue when given", async () => {
    await recordStorageEvent(
      {
        deviceId: "d1",
        timestamp: 1000,
        applicationId: null,
        sessionId: null,
        fileName: "prefs.xml",
        key: "k",
        value: "v2",
        valueType: null,
        changeType: "modify",
        previousValue: "v1",
      },
      db,
    );
    const events = await getStorageEvents({ deviceId: "d1" }, db);
    expect(events[0].previousValue).toBe("v1");
  });

  test("recordStorageEvent skips the lookup when previousValue is supplied, even if a prior row exists", async () => {
    // A prior event for the same (device, file, key) would be found by the
    // auto-lookup. Supplying previousValue must short-circuit that lookup and
    // store the supplied value verbatim rather than the prior row's value.
    await recordStorageEvent(
      {
        deviceId: "d1",
        timestamp: 1000,
        applicationId: null,
        sessionId: null,
        fileName: "prefs.xml",
        key: "theme",
        value: "light",
        valueType: null,
        changeType: "add",
      },
      db,
    );
    await recordStorageEvent(
      {
        deviceId: "d1",
        timestamp: 2000,
        applicationId: null,
        sessionId: null,
        fileName: "prefs.xml",
        key: "theme",
        value: "dark",
        valueType: null,
        changeType: "modify",
        previousValue: "caller-knows",
      },
      db,
    );
    const events = await getStorageEvents({ deviceId: "d1" }, db);
    // Most-recent first; supplied value wins over the "light" the lookup would find.
    expect(events[0].previousValue).toBe("caller-knows");
  });

  test("recordStorageEvent honors an explicit previousValue: null and skips the lookup", async () => {
    // A prior row exists that the auto-lookup would find. Passing an EXPLICIT
    // null means "there is no prior value" — it must be stored verbatim, not
    // overwritten by the stale prior row. Explicit null must be distinguishable
    // from an omitted field (guarded via `input.previousValue !== undefined`).
    await recordStorageEvent(
      {
        deviceId: "d1",
        timestamp: 1000,
        applicationId: null,
        sessionId: null,
        fileName: "prefs.xml",
        key: "theme",
        value: "light",
        valueType: null,
        changeType: "add",
      },
      db,
    );
    await recordStorageEvent(
      {
        deviceId: "d1",
        timestamp: 2000,
        applicationId: null,
        sessionId: null,
        fileName: "prefs.xml",
        key: "theme",
        value: "dark",
        valueType: null,
        changeType: "modify",
        previousValue: null,
      },
      db,
    );
    const events = await getStorageEvents({ deviceId: "d1", limit: 10 }, db);
    // Most-recent first; explicit null wins over the "light" the lookup would find.
    expect(events[0].previousValue).toBeNull();
  });

  test("recordStorageEvent picks the max-timestamp prior row regardless of insertion order", async () => {
    // Insert out of timestamp order: the newest row (timestamp 3000) is inserted
    // in the middle. The lookup must return its value by MAX(timestamp), not by
    // insertion/rowid order — this is exactly what the trailing timestamp column
    // of idx_storage_events_key_lookup guarantees.
    await recordStorageEvent(
      {
        deviceId: "d1",
        timestamp: 1000,
        applicationId: null,
        sessionId: null,
        fileName: "prefs.xml",
        key: "theme",
        value: "oldest",
        valueType: null,
        changeType: "add",
      },
      db,
    );
    await recordStorageEvent(
      {
        deviceId: "d1",
        timestamp: 3000,
        applicationId: null,
        sessionId: null,
        fileName: "prefs.xml",
        key: "theme",
        value: "newest",
        valueType: null,
        changeType: "modify",
      },
      db,
    );
    await recordStorageEvent(
      {
        deviceId: "d1",
        timestamp: 2000,
        applicationId: null,
        sessionId: null,
        fileName: "prefs.xml",
        key: "theme",
        value: "middle",
        valueType: null,
        changeType: "modify",
      },
      db,
    );
    // A fourth event whose auto-lookup should see "newest" as the previous value.
    await recordStorageEvent(
      {
        deviceId: "d1",
        timestamp: 4000,
        applicationId: null,
        sessionId: null,
        fileName: "prefs.xml",
        key: "theme",
        value: "current",
        valueType: null,
        changeType: "modify",
      },
      db,
    );
    const events = await getStorageEvents({ deviceId: "d1", limit: 10 }, db);
    expect(events[0].value).toBe("current");
    expect(events[0].previousValue).toBe("newest");
  });

  test("recordStorageEvent scopes the previous-value lookup by file_name and key", async () => {
    // Same device, different (file_name, key) tuples must not leak previous values
    // across each other — the seek prefix is (device_id, file_name, key).
    await recordStorageEvent(
      {
        deviceId: "d1",
        timestamp: 1000,
        applicationId: null,
        sessionId: null,
        fileName: "a.xml",
        key: "k",
        value: "from-a",
        valueType: null,
        changeType: "add",
      },
      db,
    );
    await recordStorageEvent(
      {
        deviceId: "d1",
        timestamp: 2000,
        applicationId: null,
        sessionId: null,
        fileName: "b.xml",
        key: "k",
        value: "from-b",
        valueType: null,
        changeType: "add",
      },
      db,
    );
    const events = await getStorageEvents({ deviceId: "d1", limit: 10 }, db);
    const b = events.find((e) => e.fileName === "b.xml");
    // b.xml/k has no prior row of its own → no previous value leaks from a.xml/k.
    expect(b?.previousValue).toBeNull();
  });

  test("recordStorageEvent skips previous value lookup when key is null", async () => {
    await recordStorageEvent(
      {
        deviceId: "d1",
        timestamp: 1000,
        applicationId: null,
        sessionId: null,
        fileName: "prefs.xml",
        key: null,
        value: null,
        valueType: null,
        changeType: "clear",
      },
      db,
    );
    const events = await getStorageEvents({ deviceId: "d1" }, db);
    expect(events[0].previousValue).toBeNull();
  });

  test("recordStorageEvent skips previous value lookup when deviceId is null", async () => {
    await recordStorageEvent(
      {
        deviceId: null,
        timestamp: 1000,
        applicationId: null,
        sessionId: null,
        fileName: "prefs.xml",
        key: "k",
        value: "v",
        valueType: null,
        changeType: "add",
      },
      db,
    );
    const events = await getStorageEvents({}, db);
    expect(events[0].previousValue).toBeNull();
  });

  describe("previous-value lookup query count (acceptance #3000)", () => {
    // A Kysely wired with a `log` sink that counts SELECT statements issued
    // against `storage_events`. This is the "query-counting fake" the issue
    // acceptance asks for: with a runner-supplied previousValue the hot path
    // must issue ZERO such SELECTs.
    const buildCountingDb = (): { db: Kysely<Database>; selectCount: () => number } => {
      let selects = 0;
      const bunDb = new BunDatabase(":memory:");
      const kysely = new Kysely<Database>({
        dialect: new BunSqliteDialect({ database: bunDb }),
        log: (event) => {
          if (event.level === "query") {
            const sql = event.query.sql.toLowerCase();
            // Match ONLY the previous-value lookup shape (`select "value" from
            // "storage_events" …`), not the retention gate's `count(*)`/`timestamp`
            // probes — so the assertion can't be confounded if retention ever fires
            // (it won't at this fixture size, but keep the filter precise).
            if (sql.startsWith('select "value"') && sql.includes("storage_events")) {
              selects += 1;
            }
          }
        },
      });
      return { db: kysely, selectCount: () => selects };
    };

    test("issues NO select on the hot path when previousValue is supplied", async () => {
      const { db: counting, selectCount } = buildCountingDb();
      await runMigrations(counting as Kysely<unknown>);
      try {
        // A competing prior row exists that the auto-lookup WOULD read.
        await recordStorageEvent(
          {
            deviceId: "d1",
            timestamp: 1000,
            applicationId: null,
            sessionId: null,
            fileName: "prefs.xml",
            key: "theme",
            value: "light",
            valueType: null,
            changeType: "add",
          },
          counting,
        );
        const baseline = selectCount();

        await recordStorageEvent(
          {
            deviceId: "d1",
            timestamp: 2000,
            applicationId: null,
            sessionId: null,
            fileName: "prefs.xml",
            key: "theme",
            value: "dark",
            valueType: null,
            changeType: "modify",
            previousValue: "runner-supplied",
          },
          counting,
        );

        // No new SELECT against storage_events was issued for the supplied insert.
        expect(selectCount()).toBe(baseline);
        const events = await getStorageEvents({ deviceId: "d1", limit: 10 }, counting);
        expect(events[0].previousValue).toBe("runner-supplied");
      } finally {
        await counting.destroy();
      }
    });

    test("issues a select on the hot path when previousValue is omitted (auto-lookup)", async () => {
      const { db: counting, selectCount } = buildCountingDb();
      await runMigrations(counting as Kysely<unknown>);
      try {
        await recordStorageEvent(
          {
            deviceId: "d1",
            timestamp: 1000,
            applicationId: null,
            sessionId: null,
            fileName: "prefs.xml",
            key: "theme",
            value: "light",
            valueType: null,
            changeType: "add",
          },
          counting,
        );
        const baseline = selectCount();

        await recordStorageEvent(
          {
            deviceId: "d1",
            timestamp: 2000,
            applicationId: null,
            sessionId: null,
            fileName: "prefs.xml",
            key: "theme",
            value: "dark",
            valueType: null,
            changeType: "modify",
          },
          counting,
        );

        // The omitted-field path performs the previous-value lookup.
        expect(selectCount()).toBeGreaterThan(baseline);
      } finally {
        await counting.destroy();
      }
    });
  });

  test("getStorageEvents filters by deviceId", async () => {
    await recordStorageEvent(
      {
        deviceId: "d1",
        timestamp: 1000,
        applicationId: null,
        sessionId: null,
        fileName: "f",
        key: "k",
        value: "v",
        valueType: null,
        changeType: "add",
      },
      db,
    );
    await recordStorageEvent(
      {
        deviceId: "d2",
        timestamp: 2000,
        applicationId: null,
        sessionId: null,
        fileName: "f",
        key: "k2",
        value: "v2",
        valueType: null,
        changeType: "add",
      },
      db,
    );
    const events = await getStorageEvents({ deviceId: "d1" }, db);
    expect(events).toHaveLength(1);
    expect(events[0].key).toBe("k");
  });

  test("getStorageEvents filters by sinceTimestamp", async () => {
    await recordStorageEvent(
      {
        deviceId: "d1",
        timestamp: 100,
        applicationId: null,
        sessionId: null,
        fileName: "f",
        key: "k1",
        value: "v1",
        valueType: null,
        changeType: "add",
      },
      db,
    );
    await recordStorageEvent(
      {
        deviceId: "d1",
        timestamp: 200,
        applicationId: null,
        sessionId: null,
        fileName: "f",
        key: "k2",
        value: "v2",
        valueType: null,
        changeType: "add",
      },
      db,
    );
    const events = await getStorageEvents({ sinceTimestamp: 150 }, db);
    expect(events).toHaveLength(1);
    expect(events[0].key).toBe("k2");
  });

  // The auto-lookup path opens its own transaction ONLY when the executor is not
  // already a transaction (storageEventRepository.ts:87-91). A batched caller
  // that passes a `trx` handle must run the body directly — opening a nested
  // BEGIN throws "cannot start a transaction within a transaction". These two
  // tests both die if the `!d.isTransaction` guard is dropped.
  test("recordStorageEvent auto-lookup succeeds when the executor is already a transaction", async () => {
    await db.transaction().execute(async (trx) => {
      await recordStorageEvent(
        {
          deviceId: "d1",
          timestamp: 1000,
          applicationId: "com.example",
          sessionId: "s1",
          fileName: "prefs.xml",
          key: "theme",
          value: "light",
          valueType: "STRING",
          changeType: "add",
        },
        trx,
      );
    });

    const events = await getStorageEvents({ deviceId: "d1" }, db);
    expect(events).toHaveLength(1);
    expect(events[0].value).toBe("light");
  });

  test("recordStorageEvent resolves the previous value inside a caller transaction", async () => {
    await recordStorageEvent(
      {
        deviceId: "d1",
        timestamp: 1000,
        applicationId: "com.example",
        sessionId: "s1",
        fileName: "prefs.xml",
        key: "theme",
        value: "light",
        valueType: "STRING",
        changeType: "add",
      },
      db,
    );

    await db.transaction().execute(async (trx) => {
      await recordStorageEvent(
        {
          deviceId: "d1",
          timestamp: 2000,
          applicationId: "com.example",
          sessionId: "s1",
          fileName: "prefs.xml",
          key: "theme",
          value: "dark",
          valueType: "STRING",
          changeType: "modify",
        },
        trx,
      );
    });

    const events = await getStorageEvents({ deviceId: "d1" }, db);
    // Most recent first; the auto-lookup ran inside the caller transaction.
    expect(events[0].previousValue).toBe("light");
  });
});
