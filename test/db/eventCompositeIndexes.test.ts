import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { EVENT_TABLES } from "../../src/db/eventTables";
import { runMigrations } from "../../src/db/migrator";
import { up as telemetryUp } from "../../src/db/migrations/2026_03_15_000_telemetry_events";
import { up as navigationUp } from "../../src/db/migrations/2026_03_18_000_navigation_events";
import { up as storageUp } from "../../src/db/migrations/2026_03_19_000_storage_events";
import { up as layoutUp } from "../../src/db/migrations/2026_03_19_001_layout_events";
import {
  up as compositeUp,
  down as compositeDown,
} from "../../src/db/migrations/2026_07_02_000_event_composite_indexes";

/**
 * Migration coverage for #2788. The six telemetry event tables carry only
 * single-column indexes on `device_id` and `timestamp` separately, so the
 * common getter shape (`WHERE device_id=? ORDER BY timestamp DESC LIMIT n`)
 * forces a temp B-tree filesort. This migration adds a composite
 * `(device_id, timestamp)` index per table so SQLite satisfies both the filter
 * and the ordering from one index (scanning it backward for the DESC order).
 *
 * The tests assert the whole point is real: the composite index exists, the
 * planner actually uses it, the filesort disappears, results are unchanged, and
 * the migration is idempotent / reversible / replay-safe.
 */
/**
 * Build the six event tables via their original migrations (no composite index
 * yet). The later `alterTable` migrations (…_002_storage_events_previous_value,
 * …_003_layout_events_screen_name) are intentionally omitted: the composite only
 * touches `device_id`/`timestamp`, which exist at table creation. The full
 * migration chain (including those alters) is exercised by the "full replay"
 * describe below.
 */
async function buildEventSchema(db: Kysely<unknown>): Promise<void> {
  await telemetryUp(db); // network_events, log_events, os_events (+ custom_events)
  await navigationUp(db); // navigation_events
  await storageUp(db); // storage_events
  await layoutUp(db); // layout_events
}

async function indexExists(db: Kysely<unknown>, name: string): Promise<boolean> {
  const result = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'index' AND name = ${name}
  `.execute(db);
  return result.rows.length > 0;
}

/** Ordered list of column names participating in an index (PRAGMA index_info). */
async function indexColumns(db: Kysely<unknown>, name: string): Promise<string[]> {
  const result = await sql<{ seqno: number; name: string }>`
    SELECT seqno, name FROM pragma_index_info(${name}) ORDER BY seqno
  `.execute(db);
  return result.rows.map((r) => r.name);
}

/**
 * EXPLAIN QUERY PLAN detail lines for the canonical getter shape. Runs against
 * the raw bun:sqlite handle: kysely's `sql` execute returns no rows for
 * EXPLAIN QUERY PLAN (the dialect routes non-SELECT statements through run()).
 */
function queryPlan(bunDb: BunDatabase, table: string): string[] {
  const rows = bunDb
    .query(
      `EXPLAIN QUERY PLAN SELECT * FROM ${table} WHERE device_id = 'dev-1' ORDER BY timestamp DESC LIMIT 100`,
    )
    .all() as Array<{ detail: string }>;
  return rows.map((r) => r.detail);
}

describe("2026_07_02_000_event_composite_indexes migration", () => {
  let bunDb: BunDatabase;
  let db: Kysely<unknown>;

  beforeEach(async () => {
    bunDb = new BunDatabase(":memory:");
    db = new Kysely<unknown>({ dialect: new BunSqliteDialect({ database: bunDb }) });
    await buildEventSchema(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("up creates a composite (device_id, timestamp) index on all six tables", async () => {
    for (const table of EVENT_TABLES) {
      expect(await indexExists(db, `idx_${table}_device_timestamp`)).toBe(false);
    }

    await compositeUp(db);

    for (const table of EVENT_TABLES) {
      const name = `idx_${table}_device_timestamp`;
      expect(await indexExists(db, name)).toBe(true);
      // Columns are ordered (device_id, timestamp) ascending — mirrors precedent.
      expect(await indexColumns(db, name)).toEqual(["device_id", "timestamp"]);
    }
  });

  test("planner uses the composite index and drops the temp B-tree filesort", async () => {
    // Before: device filter picks the single-column device index, forcing a sort.
    for (const table of EVENT_TABLES) {
      const before = queryPlan(bunDb, table).join("\n");
      expect(before).toContain("USE TEMP B-TREE FOR ORDER BY");
    }

    await compositeUp(db);

    for (const table of EVENT_TABLES) {
      const after = queryPlan(bunDb, table).join("\n");
      const indexName = `idx_${table}_device_timestamp`;
      // The composite index now satisfies both the equality filter and the order.
      expect(after).toContain(indexName);
      expect(after).toMatch(new RegExp(`SEARCH .*USING INDEX ${indexName}`));
      // The whole point: no filesort remains.
      expect(after).not.toContain("USE TEMP B-TREE FOR ORDER BY");
    }
  });

  test("query results are byte-for-byte identical before and after the migration", async () => {
    // Seed interleaved timestamps across two devices so ordering/filtering matters.
    await sql`INSERT INTO network_events (device_id, timestamp, url, method, status_code, duration_ms)
      VALUES ('dev-1', 300, 'https://a', 'GET', 200, 1),
             ('dev-1', 100, 'https://b', 'GET', 200, 1),
             ('dev-1', 200, 'https://c', 'GET', 200, 1),
             ('dev-2', 250, 'https://d', 'GET', 200, 1)`.execute(db);

    const read = async (): Promise<Array<{ url: string; timestamp: number }>> => {
      const result = await sql<{ url: string; timestamp: number }>`
        SELECT url, timestamp FROM network_events
        WHERE device_id = 'dev-1' ORDER BY timestamp DESC LIMIT 100
      `.execute(db);
      return result.rows;
    };

    const before = await read();
    await compositeUp(db);
    const after = await read();

    expect(after).toEqual(before);
    // Sanity: correct rows in correct DESC order (dev-2 excluded).
    expect(after.map((r) => r.timestamp)).toEqual([300, 200, 100]);
  });

  test("up is idempotent (safe to re-run, as destructive-recovery replay would)", async () => {
    await compositeUp(db);
    await expect(compositeUp(db)).resolves.toBeUndefined();
    for (const table of EVENT_TABLES) {
      expect(await indexExists(db, `idx_${table}_device_timestamp`)).toBe(true);
    }
  });

  test("up skips canonical tables that are not present yet during replay", async () => {
    const partialBunDb = new BunDatabase(":memory:");
    const partialDb = new Kysely<unknown>({
      dialect: new BunSqliteDialect({ database: partialBunDb }),
    });
    try {
      await telemetryUp(partialDb);
      await navigationUp(partialDb);
      await storageUp(partialDb);

      await expect(compositeUp(partialDb)).resolves.toBeUndefined();
      expect(await indexExists(partialDb, "idx_storage_events_device_timestamp")).toBe(true);
      expect(await indexExists(partialDb, "idx_layout_events_device_timestamp")).toBe(false);
    } finally {
      await partialDb.destroy();
      partialBunDb.close();
    }
  });

  test("down drops all six composite indexes", async () => {
    await compositeUp(db);
    await compositeDown(db);
    for (const table of EVENT_TABLES) {
      expect(await indexExists(db, `idx_${table}_device_timestamp`)).toBe(false);
    }
  });

  test("down is idempotent — a partial-up followed by down does not throw", async () => {
    // Never ran up(): down() must be a no-op, not a throw (ifExists guards).
    await expect(compositeDown(db)).resolves.toBeUndefined();
    // And after a full up, a double down is still safe.
    await compositeUp(db);
    await compositeDown(db);
    await expect(compositeDown(db)).resolves.toBeUndefined();
  });

  test("single-column indexes are left intact (other queries + retention still benefit)", async () => {
    await compositeUp(db);
    // Original standalone indexes from the base migrations must survive.
    expect(await indexExists(db, "idx_network_events_timestamp")).toBe(true);
    expect(await indexExists(db, "idx_network_events_device")).toBe(true);
  });
});

describe("2026_07_02_000_event_composite_indexes migration — full replay", () => {
  let db: Kysely<unknown>;

  beforeEach(async () => {
    db = new Kysely<unknown>({
      dialect: new BunSqliteDialect({ database: new BunDatabase(":memory:") }),
    });
    // Full forward replay of every migration on a fresh DB (the #2785
    // destructive-recovery path). Proves the migration is discovered/wired and
    // runs cleanly in filename order after the tables it indexes exist.
    await runMigrations(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("the composite indexes exist after a fresh full migration chain", async () => {
    for (const table of EVENT_TABLES) {
      expect(await indexExists(db, `idx_${table}_device_timestamp`)).toBe(true);
    }
  });
});
