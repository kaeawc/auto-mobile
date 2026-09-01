import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { EVENT_TABLES } from "../../src/db/eventTables";
import { runMigrations } from "../../src/db/migrator";

/**
 * Standing drift guard for the telemetry event tables' index inventory
 * (issue #2908, follow-up to #2893 / PR #2904).
 *
 * Provenance of the intended shape:
 *   - #2788 scoped the composite-index work as additive-only.
 *   - PR #2890 (`2026_07_02_000_event_composite_indexes.ts`) added the
 *     `(device_id, timestamp)` composite indexes on all six event tables.
 *   - #2893 / PR #2904 (`2026_07_03_000_drop_redundant_device_indexes.ts`)
 *     dropped the now-redundant standalone `idx_<table>_device` indexes — a
 *     composite `(device_id, timestamp)` serves every `device_id=?` access path
 *     via the left-prefix rule, so the single-column device index was pure
 *     per-insert write amplification.
 *
 * `dropRedundantDeviceIndexes.integration.test.ts` proves that *one migration* is correct.
 * It does NOT stop a *future* migration from silently re-adding an
 * `idx_<table>_device` index (re-introducing the exact write amplification
 * #2893 removed), dropping the `timestamp` index the retention cutoff scan
 * depends on, or — subtler — recreating a same-named index over the WRONG
 * columns (e.g. reordering the composite to `(timestamp, device_id)`, which
 * breaks the `device_id=?` left-prefix path that is the whole rationale). This
 * test is that standing guard: it replays the whole migration chain and pins
 * the canonical per-table index inventory *including each index's column
 * composition*, so any future migration that perturbs it must consciously
 * update the canonical set below.
 */

/**
 * Canonical explicit-index inventory per table after a full `runMigrations`
 * replay (post-#2904): index name → ordered column list. Every entry is a
 * `CREATE INDEX` (PRAGMA index_list origin `c`); the auto-created PK/rowid
 * index is intentionally excluded.
 *
 * Invariants this set encodes:
 *   - `idx_<table>_timestamp` → `[timestamp]`         — retention cutoff covering scan, MUST stay.
 *   - `idx_<table>_device_timestamp` → `[device_id, timestamp]`
 *                                                     — composite; the column ORDER is load-bearing:
 *                                                       `device_id` must be the left prefix or the
 *                                                       `device_id=?` access paths regress.
 *   - category/content index where the table has one.
 *   - NO standalone `idx_<table>_device` — dropped in #2904, must not return.
 *
 * The keys of this map are also the authoritative list of the six telemetry
 * event tables; the guard asserts the live `%_events` table set equals these
 * keys, so a future 7th event table can't be silently outside the guard.
 */
const CANONICAL_INDEXES: Record<string, Record<string, string[]>> = {
  network_events: {
    idx_network_events_timestamp: ["timestamp"],
    idx_network_events_host: ["host"],
    idx_network_events_device_timestamp: ["device_id", "timestamp"],
  },
  log_events: {
    idx_log_events_timestamp: ["timestamp"],
    idx_log_events_tag: ["tag"],
    idx_log_events_device_timestamp: ["device_id", "timestamp"],
  },
  os_events: {
    idx_os_events_timestamp: ["timestamp"],
    idx_os_events_category: ["category"],
    idx_os_events_device_timestamp: ["device_id", "timestamp"],
  },
  navigation_events: {
    idx_navigation_events_timestamp: ["timestamp"],
    idx_navigation_events_device_timestamp: ["device_id", "timestamp"],
  },
  storage_events: {
    idx_storage_events_timestamp: ["timestamp"],
    idx_storage_events_device_timestamp: ["device_id", "timestamp"],
    // #2798: three-column equality prefix + trailing timestamp for the
    // per-insert previous-value lookup
    // (WHERE device_id=? AND file_name=? AND key=? ORDER BY timestamp DESC LIMIT 1).
    idx_storage_events_key_lookup: ["device_id", "file_name", "key", "timestamp"],
  },
  layout_events: {
    idx_layout_events_timestamp: ["timestamp"],
    idx_layout_events_device_timestamp: ["device_id", "timestamp"],
  },
};

const TABLES = [...EVENT_TABLES];

test("EVENT_TABLES is the canonical table list used by the telemetry index guard", () => {
  expect([...TABLES].sort()).toEqual(Object.keys(CANONICAL_INDEXES).sort());
});

/**
 * Explicit-index inventory of a table: name → ordered columns, ignoring the
 * auto-created PK/rowid index (origin `pk`) and any auto UNIQUE-constraint
 * index (origin `u`). The guard pins the deliberate `idx_*` inventory only.
 *
 * `pragma_index_list` on a NON-existent table returns `[]` rather than raising,
 * so a vanished/renamed table would otherwise make every per-table assertion
 * pass vacuously — the `tables present in the schema` test below closes that
 * hole by pinning the live table set independently.
 */
async function explicitIndexInventory(
  db: Kysely<unknown>,
  table: string,
): Promise<Record<string, string[]>> {
  const indexes = await sql<{ name: string; origin: string }>`
    SELECT name, origin FROM pragma_index_list(${table})
  `.execute(db);

  const inventory: Record<string, string[]> = {};
  for (const index of indexes.rows) {
    if (index.origin !== "c") {
      continue;
    }
    const columns = await sql<{ name: string }>`
      SELECT name FROM pragma_index_info(${index.name}) ORDER BY seqno
    `.execute(db);
    inventory[index.name] = columns.rows.map((c) => c.name);
  }
  return inventory;
}

/** All tables whose name ends in `_events` in the live schema (drift-detects a new event table). */
async function liveEventTables(db: Kysely<unknown>): Promise<string[]> {
  const result = await sql<{ name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name LIKE '%\\_events' ESCAPE '\\'
    ORDER BY name
  `.execute(db);
  return result.rows.map((r) => r.name);
}

describe("telemetry event tables index inventory drift guard (#2908)", () => {
  let db: Kysely<unknown>;

  beforeAll(async () => {
    // Full forward replay of every on-disk migration against a fresh :memory:
    // DB — the same path the #2785 destructive-recovery rebuild takes. No
    // provider override: this asserts the *shipped* migration chain, so a new
    // migration file is exercised the moment it lands. A single shared DB is
    // safe here because every test below is strictly read-only.
    db = new Kysely<unknown>({
      dialect: new BunSqliteDialect({ database: new BunDatabase(":memory:") }),
    });
    await runMigrations(db);
  });

  afterAll(async () => {
    await db.destroy();
  });

  test("the live schema has exactly the six canonical event tables (no new table escapes the guard)", async () => {
    const actual = (await liveEventTables(db)).sort();
    const expected = [...TABLES].sort();
    // A newly-added `%_events` table (e.g. a future `custom_events` revival with
    // its own device index) forces a conscious edit to CANONICAL_INDEXES here,
    // rather than silently sailing past a hardcoded table list.
    expect(actual).toEqual(expected);
  });

  test("each event table has exactly its canonical explicit-index inventory (names AND columns)", async () => {
    for (const table of TABLES) {
      const actual = await explicitIndexInventory(db, table);
      // Deep equality on name → columns catches every drift direction in one
      // assertion: an added index (a re-introduced idx_<table>_device), a
      // removed index (a dropped timestamp/composite), AND a same-named index
      // recreated over the wrong columns or wrong order.
      expect(actual).toEqual(CANONICAL_INDEXES[table]);
    }
  });

  test("no standalone idx_<table>_device index reappears (the #2893 regression)", async () => {
    for (const table of TABLES) {
      const names = Object.keys(await explicitIndexInventory(db, table));
      expect(names).not.toContain(`idx_${table}_device`);
    }
  });

  test("the retention-cutoff timestamp index survives, covering [timestamp], for every table", async () => {
    for (const table of TABLES) {
      const inventory = await explicitIndexInventory(db, table);
      expect(inventory[`idx_${table}_timestamp`]).toEqual(["timestamp"]);
    }
  });

  test("the device_id composite survives with device_id as the load-bearing left prefix", async () => {
    for (const table of TABLES) {
      const inventory = await explicitIndexInventory(db, table);
      expect(inventory[`idx_${table}_device_timestamp`]).toEqual(["device_id", "timestamp"]);
    }
  });
});
