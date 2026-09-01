import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { runMigrations } from "../../src/db/migrator";
import { up as telemetryUp } from "../../src/db/migrations/2026_03_15_000_telemetry_events";
import { up as navigationUp } from "../../src/db/migrations/2026_03_18_000_navigation_events";
import { up as storageUp } from "../../src/db/migrations/2026_03_19_000_storage_events";
import { up as layoutUp } from "../../src/db/migrations/2026_03_19_001_layout_events";
import { up as storagePreviousValueUp } from "../../src/db/migrations/2026_03_19_002_storage_events_previous_value";
import { up as compositeUp } from "../../src/db/migrations/2026_07_02_000_event_composite_indexes";
import { up as dropRedundantUp } from "../../src/db/migrations/2026_07_03_000_drop_redundant_device_indexes";
import {
  up as keyLookupUp,
  down as keyLookupDown,
} from "../../src/db/migrations/2026_07_04_000_storage_events_key_lookup";

/**
 * Migration coverage for #2798. `recordStorageEvent` runs a per-insert
 * previous-value lookup:
 *
 *   SELECT value FROM storage_events
 *   WHERE device_id=? AND file_name=? AND key=?
 *   ORDER BY timestamp DESC LIMIT 1
 *
 * The issue was originally filed against the pre-#2788 schema, where the only
 * usable index was the standalone `idx_storage_events_device` and the plan showed
 * `USE TEMP B-TREE FOR ORDER BY`. By the time this lands, #2788 (PR #2890) has
 * added `idx_storage_events_device_timestamp (device_id, timestamp)` and #2893
 * (PR #2904) dropped the standalone device index, so the temp B-tree is ALREADY
 * gone — the composite's `device_id` prefix satisfies the DESC order. The
 * remaining, real win this migration delivers is narrowing the SEEK: without it
 * the planner seeks only on `device_id=?` and then scans every row for that device
 * (in timestamp order) applying `file_name=?`/`key=?` row-by-row until the first
 * match; with `(device_id, file_name, key, timestamp)` it does a full three-column
 * equality prefix seek straight to the target key's newest row.
 *
 * These tests pin: the index exists with the correct ordered columns, the planner
 * switches to the three-column prefix seek, the temp B-tree stays absent, results
 * are unchanged, and the migration is idempotent / reversible / replay-safe.
 */
const INDEX = "idx_storage_events_key_lookup";

/**
 * Reproduce the storage_events index state as it exists in production
 * immediately BEFORE this migration: base table + timestamp index, the
 * previous_value column, the #2788 composite, and the #2893 device-index drop.
 * The composite/drop migrations touch all six event tables, so every event
 * table must exist first.
 */
async function buildPreMigrationSchema(db: Kysely<unknown>): Promise<void> {
  await telemetryUp(db); // network_events, log_events, os_events
  await navigationUp(db); // navigation_events
  await storageUp(db); // storage_events (+ timestamp + device indexes)
  await layoutUp(db); // layout_events
  await storagePreviousValueUp(db); // previous_value column
  await compositeUp(db); // idx_<table>_device_timestamp on all six
  await dropRedundantUp(db); // drop idx_<table>_device on all six
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
 * EXPLAIN QUERY PLAN detail lines for the real previous-value lookup predicate
 * (matches `storageEventRepository.ts`). Runs against the raw bun:sqlite handle:
 * kysely's `sql` execute returns no rows for EXPLAIN QUERY PLAN.
 */
function lookupPlan(bunDb: BunDatabase): string[] {
  const rows = bunDb
    .query(
      "EXPLAIN QUERY PLAN SELECT value FROM storage_events " +
        "WHERE device_id = 'dev-1' AND file_name = 'prefs.xml' AND key = 'theme' " +
        "ORDER BY timestamp DESC LIMIT 1",
    )
    .all() as Array<{ detail: string }>;
  return rows.map((r) => r.detail);
}

describe("2026_07_04_000_storage_events_key_lookup migration", () => {
  let bunDb: BunDatabase;
  let db: Kysely<unknown>;

  beforeEach(async () => {
    bunDb = new BunDatabase(":memory:");
    db = new Kysely<unknown>({ dialect: new BunSqliteDialect({ database: bunDb }) });
    await buildPreMigrationSchema(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("up creates the composite seek index with ordered columns", async () => {
    expect(await indexExists(db, INDEX)).toBe(false);

    await keyLookupUp(db);

    expect(await indexExists(db, INDEX)).toBe(true);
    expect(await indexColumns(db, INDEX)).toEqual(["device_id", "file_name", "key", "timestamp"]);
  });

  test("planner switches to the three-column prefix seek; no temp B-tree either way", async () => {
    // Before: #2788's composite already kills the sort, but the seek is only on
    // device_id — file_name/key are filtered row-by-row, and the plan does NOT
    // reference the key-lookup index.
    const before = lookupPlan(bunDb).join("\n");
    expect(before).not.toContain(INDEX);
    expect(before).not.toContain("USE TEMP B-TREE FOR ORDER BY");

    await keyLookupUp(db);

    const after = lookupPlan(bunDb).join("\n");
    // The three equality columns are now the seek prefix — a direct descent to
    // the target key's rows instead of a device-wide scan.
    expect(after).toContain(INDEX);
    expect(after).toMatch(
      new RegExp(`SEARCH .*USING INDEX ${INDEX} \\(device_id=\\? AND file_name=\\? AND key=\\?\\)`),
    );
    // The sort stays gone (trailing timestamp column supplies the DESC order).
    expect(after).not.toContain("USE TEMP B-TREE FOR ORDER BY");
  });

  test("lookup returns the same most-recent value before and after the migration", async () => {
    await sql`INSERT INTO storage_events (device_id, timestamp, file_name, key, value, change_type)
      VALUES ('dev-1', 100, 'prefs.xml', 'theme', 'light', 'add'),
             ('dev-1', 300, 'prefs.xml', 'theme', 'dark', 'modify'),
             ('dev-1', 200, 'prefs.xml', 'theme', 'sepia', 'modify'),
             ('dev-1', 400, 'prefs.xml', 'other', 'x', 'add'),
             ('dev-2', 500, 'prefs.xml', 'theme', 'other-device', 'add')`.execute(db);

    const read = async (): Promise<Array<{ value: string }>> => {
      const result = await sql<{ value: string }>`
        SELECT value FROM storage_events
        WHERE device_id = 'dev-1' AND file_name = 'prefs.xml' AND key = 'theme'
        ORDER BY timestamp DESC LIMIT 1
      `.execute(db);
      return result.rows;
    };

    const before = await read();
    await keyLookupUp(db);
    const after = await read();

    expect(after).toEqual(before);
    // Sanity: newest matching row for (dev-1, prefs.xml, theme) is timestamp 300.
    expect(after[0].value).toBe("dark");
  });

  test("up is idempotent (safe to re-run, as destructive-recovery replay would)", async () => {
    await keyLookupUp(db);
    await expect(keyLookupUp(db)).resolves.toBeUndefined();
    expect(await indexExists(db, INDEX)).toBe(true);
  });

  test("down drops the index", async () => {
    await keyLookupUp(db);
    await keyLookupDown(db);
    expect(await indexExists(db, INDEX)).toBe(false);
  });

  test("down is idempotent — a partial-up followed by down does not throw", async () => {
    await expect(keyLookupDown(db)).resolves.toBeUndefined();
    await keyLookupUp(db);
    await keyLookupDown(db);
    await expect(keyLookupDown(db)).resolves.toBeUndefined();
  });

  test("does not touch the #2788 composite or the retention timestamp index", async () => {
    await keyLookupUp(db);
    expect(await indexExists(db, "idx_storage_events_device_timestamp")).toBe(true);
    expect(await indexExists(db, "idx_storage_events_timestamp")).toBe(true);
  });
});

describe("2026_07_04_000_storage_events_key_lookup migration — full replay", () => {
  let db: Kysely<unknown>;

  beforeEach(async () => {
    db = new Kysely<unknown>({
      dialect: new BunSqliteDialect({ database: new BunDatabase(":memory:") }),
    });
    // Full forward replay of every on-disk migration (the #2785
    // destructive-recovery path). Proves the migration is discovered/wired.
    await runMigrations(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("the key-lookup index exists after a fresh full migration chain", async () => {
    expect(await indexExists(db, INDEX)).toBe(true);
    expect(await indexColumns(db, INDEX)).toEqual(["device_id", "file_name", "key", "timestamp"]);
  });
});
