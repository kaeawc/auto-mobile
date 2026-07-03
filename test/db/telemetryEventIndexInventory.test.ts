import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
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
 * `dropRedundantDeviceIndexes.test.ts` proves that *one migration* is correct.
 * It does NOT stop a *future* migration from silently re-adding an
 * `idx_<table>_device` index (re-introducing the exact write amplification
 * #2893 removed) or dropping the `timestamp` index the retention cutoff scan
 * depends on. This test is that standing guard: it replays the whole migration
 * chain and pins the canonical per-table index inventory, so any future
 * migration that perturbs it must consciously update the canonical set below.
 */

/** The six telemetry event tables whose index inventory this guard pins. */
const TABLES = [
  "network_events",
  "log_events",
  "os_events",
  "navigation_events",
  "storage_events",
  "layout_events",
] as const;

/**
 * Canonical explicit-index inventory per table after a full `runMigrations`
 * replay (post-#2904). Every entry is a `CREATE INDEX` (PRAGMA index_list
 * origin `c`); the auto-created PK/rowid index is intentionally excluded.
 *
 * Invariants this set encodes:
 *   - `idx_<table>_timestamp`          — retention cutoff covering scan, MUST stay.
 *   - `idx_<table>_device_timestamp`   — composite; serves every `device_id=?` path.
 *   - category/content index where the table has one.
 *   - NO standalone `idx_<table>_device` — dropped in #2904, must not return.
 */
const CANONICAL_INDEXES: Record<(typeof TABLES)[number], string[]> = {
  network_events: [
    "idx_network_events_timestamp",
    "idx_network_events_host",
    "idx_network_events_device_timestamp",
  ],
  log_events: [
    "idx_log_events_timestamp",
    "idx_log_events_tag",
    "idx_log_events_device_timestamp",
  ],
  os_events: [
    "idx_os_events_timestamp",
    "idx_os_events_category",
    "idx_os_events_device_timestamp",
  ],
  navigation_events: [
    "idx_navigation_events_timestamp",
    "idx_navigation_events_device_timestamp",
  ],
  storage_events: [
    "idx_storage_events_timestamp",
    "idx_storage_events_device_timestamp",
  ],
  layout_events: [
    "idx_layout_events_timestamp",
    "idx_layout_events_device_timestamp",
  ],
};

/**
 * Names of the explicitly-created (`CREATE INDEX`) indexes attached to a table,
 * ignoring the auto-created PK/rowid index (origin `pk`) and any auto UNIQUE
 * index (origin `u`) — the guard pins the deliberate `idx_*` inventory only.
 */
async function explicitIndexNames(db: Kysely<unknown>, table: string): Promise<string[]> {
  const result = await sql<{ name: string; origin: string }>`
    SELECT name, origin FROM pragma_index_list(${table})
  `.execute(db);
  return result.rows.filter(r => r.origin === "c").map(r => r.name);
}

describe("telemetry event tables index inventory drift guard (#2908)", () => {
  let db: Kysely<unknown>;

  beforeEach(async () => {
    // Full forward replay of every on-disk migration against a fresh :memory:
    // DB — the same path the #2785 destructive-recovery rebuild takes. No
    // provider override: this asserts the *shipped* migration chain, so a new
    // migration file is exercised here the moment it lands.
    db = new Kysely<unknown>({
      dialect: new BunSqliteDialect({ database: new BunDatabase(":memory:") }),
    });
    await runMigrations(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("each event table has exactly its canonical explicit-index inventory", async () => {
    for (const table of TABLES) {
      const actual = (await explicitIndexNames(db, table)).sort();
      const expected = [...CANONICAL_INDEXES[table]].sort();
      // Set equality catches BOTH drift directions in one assertion: an added
      // index (e.g. a re-introduced idx_<table>_device) and a removed one
      // (e.g. a dropped timestamp/composite index).
      expect(actual).toEqual(expected);
    }
  });

  test("no standalone idx_<table>_device index reappears (the #2893 regression)", async () => {
    for (const table of TABLES) {
      const names = await explicitIndexNames(db, table);
      expect(names).not.toContain(`idx_${table}_device`);
    }
  });

  test("the retention-cutoff timestamp index survives for every table", async () => {
    for (const table of TABLES) {
      const names = await explicitIndexNames(db, table);
      expect(names).toContain(`idx_${table}_timestamp`);
    }
  });

  test("the device_id composite index survives for every table", async () => {
    for (const table of TABLES) {
      const names = await explicitIndexNames(db, table);
      expect(names).toContain(`idx_${table}_device_timestamp`);
    }
  });
});
