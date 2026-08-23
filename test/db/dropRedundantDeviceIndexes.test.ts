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
import { up as compositeUp } from "../../src/db/migrations/2026_07_02_000_event_composite_indexes";
import {
  up as dropUp,
  down as dropDown,
} from "../../src/db/migrations/2026_07_03_000_drop_redundant_device_indexes";

/**
 * Migration coverage for #2893 (follow-up to #2788 / PR #2890). PR #2890 added
 * composite `(device_id, timestamp)` indexes but was deliberately additive-only,
 * leaving the now-redundant standalone `idx_<table>_device` indexes in place.
 *
 * A composite `(device_id, timestamp)` index serves every `device_id=?` access
 * path the standalone `(device_id)` index can, via the left-prefix rule. This
 * migration drops the six redundant single-column device indexes to cut
 * per-insert write amplification.
 *
 * The tests assert the whole point is real: the six device indexes are gone, the
 * planner still serves every `device_id=?` shape (equality, ordered, COUNT) from
 * the composite with no filesort, the standalone `timestamp` and category indexes
 * are left intact, and the migration is reversible / idempotent / replay-safe.
 */
/** Category/content indexes that must survive the drop (different query shapes). */
const CATEGORY_INDEX: Partial<Record<(typeof EVENT_TABLES)[number], string>> = {
  network_events: "idx_network_events_host",
  log_events: "idx_log_events_tag",
  os_events: "idx_os_events_category",
};

/**
 * Build the six event tables via their original migrations, then add the
 * composite indexes (#2790's precedent). The drop migration only makes sense
 * once the composite that subsumes the device index exists.
 */
async function buildEventSchema(db: Kysely<unknown>): Promise<void> {
  await telemetryUp(db); // network_events, log_events, os_events (+ custom_events)
  await navigationUp(db); // navigation_events
  await storageUp(db); // storage_events
  await layoutUp(db); // layout_events
  await compositeUp(db); // idx_<table>_device_timestamp on all six
}

async function indexExists(db: Kysely<unknown>, name: string): Promise<boolean> {
  const result = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'index' AND name = ${name}
  `.execute(db);
  return result.rows.length > 0;
}

/** Ordered column names participating in an index (PRAGMA index_info). */
async function indexColumns(db: Kysely<unknown>, name: string): Promise<string[]> {
  const result = await sql<{ seqno: number; name: string }>`
    SELECT seqno, name FROM pragma_index_info(${name}) ORDER BY seqno
  `.execute(db);
  return result.rows.map((r) => r.name);
}

/** All index names attached to a table (PRAGMA index_list). */
async function indexList(db: Kysely<unknown>, table: string): Promise<string[]> {
  const result = await sql<{ name: string }>`
    SELECT name FROM pragma_index_list(${table})
  `.execute(db);
  return result.rows.map((r) => r.name);
}

/** EXPLAIN QUERY PLAN detail lines for an arbitrary statement (raw bun:sqlite handle). */
function queryPlan(bunDb: BunDatabase, sqlText: string): string[] {
  const rows = bunDb.query(`EXPLAIN QUERY PLAN ${sqlText}`).all() as Array<{ detail: string }>;
  return rows.map((r) => r.detail);
}

describe("2026_07_03_000_drop_redundant_device_indexes migration", () => {
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

  test("up drops the six redundant idx_<table>_device indexes", async () => {
    // Precondition: the device indexes exist before the drop.
    for (const table of EVENT_TABLES) {
      expect(await indexExists(db, `idx_${table}_device`)).toBe(true);
    }

    await dropUp(db);

    // sqlite_master no longer lists any of the six device indexes.
    for (const table of EVENT_TABLES) {
      expect(await indexExists(db, `idx_${table}_device`)).toBe(false);
    }
  });

  test("up leaves the composite, timestamp, and category indexes intact", async () => {
    await dropUp(db);

    for (const table of EVENT_TABLES) {
      const list = await indexList(db, table);
      // Composite survives — it is what subsumes the dropped device index.
      expect(list).toContain(`idx_${table}_device_timestamp`);
      // Standalone timestamp index survives — retention cutoff covering scan.
      expect(list).toContain(`idx_${table}_timestamp`);
      // The redundant device index is gone.
      expect(list).not.toContain(`idx_${table}_device`);
      // Category/content index survives where the table has one.
      const category = CATEGORY_INDEX[table];
      if (category) {
        expect(list).toContain(category);
      }
    }
  });

  test("device_id=? ORDER BY timestamp DESC LIMIT n still uses the composite, no filesort", async () => {
    await dropUp(db);

    for (const table of EVENT_TABLES) {
      const plan = queryPlan(
        bunDb,
        `SELECT * FROM ${table} WHERE device_id = 'dev-1' ORDER BY timestamp DESC LIMIT 100`,
      ).join("\n");
      const composite = `idx_${table}_device_timestamp`;
      expect(plan).toMatch(new RegExp(`SEARCH .*USING INDEX ${composite}`));
      // The device index is gone; the composite left-prefix serves the filter,
      // and its ordering removes the sort.
      expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
    }
  });

  test("bare device_id=? (no ORDER BY) still uses the composite left-prefix", async () => {
    await dropUp(db);

    for (const table of EVENT_TABLES) {
      const plan = queryPlan(bunDb, `SELECT * FROM ${table} WHERE device_id = 'dev-1'`).join("\n");
      expect(plan).toMatch(new RegExp(`SEARCH .*USING INDEX idx_${table}_device_timestamp`));
    }
  });

  test("COUNT(*) WHERE device_id=? is served by the composite (covering scan)", async () => {
    await dropUp(db);

    for (const table of EVENT_TABLES) {
      const plan = queryPlan(bunDb, `SELECT COUNT(*) FROM ${table} WHERE device_id = 'dev-1'`).join(
        "\n",
      );
      expect(plan).toContain(`idx_${table}_device_timestamp`);
    }
  });

  test("storage previous-value lookup (device_id + extra equality predicates) still uses the composite", async () => {
    // storageEventRepository.ts:33-42 is the only device query with equality
    // predicates beyond timestamp: WHERE device_id=? AND file_name=? AND key=?
    // ORDER BY timestamp DESC LIMIT 1. The composite's device_id left-prefix
    // must still serve it (the extra columns are not indexed either way).
    await dropUp(db);

    const plan = queryPlan(
      bunDb,
      `SELECT value FROM storage_events
       WHERE device_id = 'dev-1' AND file_name = 'prefs.xml' AND key = 'theme'
       ORDER BY timestamp DESC LIMIT 1`,
    ).join("\n");
    expect(plan).toMatch(/SEARCH .*USING INDEX idx_storage_events_device_timestamp/);
    expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  test("retention cutoff (ORDER BY timestamp DESC, no device filter) still uses the timestamp index", async () => {
    await dropUp(db);

    for (const table of EVENT_TABLES) {
      const plan = queryPlan(
        bunDb,
        `SELECT timestamp FROM ${table} ORDER BY timestamp DESC LIMIT 1 OFFSET 10000`,
      ).join("\n");
      // The composite cannot substitute (device_id leads it); the standalone
      // timestamp index provides the covering scan with no filesort.
      expect(plan).toContain(`idx_${table}_timestamp`);
      expect(plan).not.toContain("USE TEMP B-TREE FOR ORDER BY");
    }
  });

  test("device_id=? query results are unchanged after the drop", async () => {
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
    await dropUp(db);
    const after = await read();

    expect(after).toEqual(before);
    expect(after.map((r) => r.timestamp)).toEqual([300, 200, 100]);
  });

  test("up is idempotent (safe to re-run, as destructive-recovery replay would)", async () => {
    await dropUp(db);
    await expect(dropUp(db)).resolves.toBeUndefined();
    for (const table of EVENT_TABLES) {
      expect(await indexExists(db, `idx_${table}_device`)).toBe(false);
    }
  });

  test("down recreates the six single-column device indexes", async () => {
    await dropUp(db);
    await dropDown(db);
    for (const table of EVENT_TABLES) {
      const name = `idx_${table}_device`;
      expect(await indexExists(db, name)).toBe(true);
      expect(await indexColumns(db, name)).toEqual(["device_id"]);
    }
  });

  test("down is idempotent — a partial-up followed by down does not throw", async () => {
    // Never dropped: down() must recreate cleanly even though indexes already exist.
    await expect(dropDown(db)).resolves.toBeUndefined();
    for (const table of EVENT_TABLES) {
      expect(await indexExists(db, `idx_${table}_device`)).toBe(true);
    }
    // And after a full up, a double down is still safe.
    await dropUp(db);
    await dropDown(db);
    await expect(dropDown(db)).resolves.toBeUndefined();
  });

  test("down skips canonical tables that are not present yet during replay", async () => {
    const partialBunDb = new BunDatabase(":memory:");
    const partialDb = new Kysely<unknown>({
      dialect: new BunSqliteDialect({ database: partialBunDb }),
    });
    try {
      await telemetryUp(partialDb);
      await navigationUp(partialDb);
      await storageUp(partialDb);

      await expect(dropDown(partialDb)).resolves.toBeUndefined();
      expect(await indexExists(partialDb, "idx_storage_events_device")).toBe(true);
      expect(await indexExists(partialDb, "idx_layout_events_device")).toBe(false);
    } finally {
      await partialDb.destroy();
      partialBunDb.close();
    }
  });
});

describe("2026_07_03_000_drop_redundant_device_indexes migration — full replay", () => {
  let db: Kysely<unknown>;

  beforeEach(async () => {
    db = new Kysely<unknown>({
      dialect: new BunSqliteDialect({ database: new BunDatabase(":memory:") }),
    });
    // Full forward replay of every migration on a fresh DB (the #2785
    // destructive-recovery path). Proves the migration is discovered/wired and
    // runs cleanly in filename order after the composite indexes exist.
    await runMigrations(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("the six device indexes are gone after a fresh full migration chain", async () => {
    for (const table of EVENT_TABLES) {
      expect(await indexExists(db, `idx_${table}_device`)).toBe(false);
    }
  });

  test("the composite and timestamp indexes survive the full chain", async () => {
    for (const table of EVENT_TABLES) {
      expect(await indexExists(db, `idx_${table}_device_timestamp`)).toBe(true);
      expect(await indexExists(db, `idx_${table}_timestamp`)).toBe(true);
    }
  });
});
