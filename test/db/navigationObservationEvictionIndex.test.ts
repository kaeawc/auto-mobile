import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { runMigrations } from "../../src/db/migrator";
import {
  up as evictionUp,
  down as evictionDown,
} from "../../src/db/migrations/2026_08_22_002_navigation_observation_eviction_index";

/**
 * Migration coverage for #5309. The size-cap eviction pass in
 * `src/db/navigationRetention.ts` walks the observation tables ordered by
 * `last_seen_at` within a `build_key_id` scope. With only the #4986 single-column
 * `idx_navigation_<t>_observations_build (build_key_id)` the planner seeks the
 * build key but then does `USE TEMP B-TREE FOR ORDER BY` for the `last_seen_at`
 * ordering. The `(build_key_id, last_seen_at)` composite this migration adds turns
 * that into an index range scan (seek the prefix, read `last_seen_at` in order).
 *
 * These tests pin: the composite exists on both tables with ordered columns, the
 * planner switches to the index and drops the temp B-tree, the migration is
 * discovered by a full replay, is idempotent / reversible / replay-safe, and does
 * not disturb the retained single-column build index.
 */
const TABLES = ["navigation_node_observations", "navigation_edge_observations"] as const;
const indexFor = (table: string): string => `idx_${table}_build_seen`;
const buildIndexFor = (table: string): string => `idx_${table}_build`;

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
  return result.rows.map(r => r.name);
}

/**
 * Minimal reproduction of the observation-table index state immediately BEFORE
 * this migration: the columns the eviction scan touches plus the #4986
 * single-column build index. Index selection depends only on the indexed columns,
 * so the focused tests stay decoupled from the full navigation migration chain
 * (its backfill reads navigation_apps/nodes/edges); the full-replay block below
 * proves wiring against the real schema.
 */
async function buildPreMigrationSchema(db: Kysely<unknown>): Promise<void> {
  for (const table of TABLES) {
    await db.schema
      .createTable(table)
      .addColumn("id", "integer", col => col.primaryKey().autoIncrement())
      .addColumn("build_key_id", "integer", col => col.notNull())
      .addColumn("last_seen_at", "integer", col => col.notNull())
      .execute();
    await db.schema.createIndex(buildIndexFor(table)).on(table).column("build_key_id").execute();
  }
}

/**
 * EXPLAIN QUERY PLAN detail lines for the per-build-key oldest-first scan that
 * the eviction subqueries in `collectOldestEvictable` evaluate. Runs against the
 * raw bun:sqlite handle: kysely's `sql` execute returns no rows for EXPLAIN.
 */
function evictionPlan(bunDb: BunDatabase, table: string): string[] {
  const rows = bunDb
    .query(
      `EXPLAIN QUERY PLAN SELECT id, last_seen_at FROM ${table} ` +
        "WHERE build_key_id = 5 ORDER BY last_seen_at ASC LIMIT 10"
    )
    .all() as Array<{ detail: string }>;
  return rows.map(r => r.detail);
}

describe("2026_08_22_002_navigation_observation_eviction_index migration", () => {
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

  test("up creates the composite eviction index on both tables with ordered columns", async () => {
    for (const table of TABLES) {
      expect(await indexExists(db, indexFor(table))).toBe(false);
    }

    await evictionUp(db);

    for (const table of TABLES) {
      expect(await indexExists(db, indexFor(table))).toBe(true);
      expect(await indexColumns(db, indexFor(table))).toEqual(["build_key_id", "last_seen_at"]);
    }
  });

  test("planner switches to the composite range scan; temp B-tree gone", async () => {
    for (const table of TABLES) {
      const before = evictionPlan(bunDb, table).join("\n");
      // Only the single-column build index exists: seek build_key_id, then sort.
      expect(before).not.toContain(indexFor(table));
      expect(before).toContain("USE TEMP B-TREE FOR ORDER BY");
    }

    await evictionUp(db);

    for (const table of TABLES) {
      const after = evictionPlan(bunDb, table).join("\n");
      expect(after).toContain(indexFor(table));
      expect(after).toMatch(
        new RegExp(`SEARCH .*USING (?:COVERING )?INDEX ${indexFor(table)} \\(build_key_id=\\?\\)`)
      );
      // The trailing last_seen_at column supplies the ASC order — no sort.
      expect(after).not.toContain("USE TEMP B-TREE FOR ORDER BY");
    }
  });

  test("oldest-first scan returns the same rows before and after the migration", async () => {
    await sql`INSERT INTO navigation_node_observations (build_key_id, last_seen_at)
      VALUES (5, 300), (5, 100), (5, 200), (7, 50)`.execute(db);

    const read = async (): Promise<Array<{ id: number; last_seen_at: number }>> => {
      const result = await sql<{ id: number; last_seen_at: number }>`
        SELECT id, last_seen_at FROM navigation_node_observations
        WHERE build_key_id = 5 ORDER BY last_seen_at ASC LIMIT 10
      `.execute(db);
      return result.rows;
    };

    const before = await read();
    await evictionUp(db);
    const after = await read();

    expect(after).toEqual(before);
    // Sanity: oldest-first within build_key_id 5 is last_seen_at 100, 200, 300.
    expect(after.map(r => r.last_seen_at)).toEqual([100, 200, 300]);
  });

  test("up is idempotent (safe to re-run, as destructive-recovery replay would)", async () => {
    await evictionUp(db);
    await expect(evictionUp(db)).resolves.toBeUndefined();
    for (const table of TABLES) {
      expect(await indexExists(db, indexFor(table))).toBe(true);
    }
  });

  test("down drops the composite index on both tables", async () => {
    await evictionUp(db);
    await evictionDown(db);
    for (const table of TABLES) {
      expect(await indexExists(db, indexFor(table))).toBe(false);
    }
  });

  test("down is idempotent — a partial-up followed by down does not throw", async () => {
    await expect(evictionDown(db)).resolves.toBeUndefined();
    await evictionUp(db);
    await evictionDown(db);
    await expect(evictionDown(db)).resolves.toBeUndefined();
  });

  test("does not touch the retained single-column build index", async () => {
    await evictionUp(db);
    for (const table of TABLES) {
      expect(await indexExists(db, buildIndexFor(table))).toBe(true);
    }
  });
});

describe("2026_08_22_002_navigation_observation_eviction_index migration — full replay", () => {
  let db: Kysely<unknown>;

  beforeEach(async () => {
    db = new Kysely<unknown>({
      dialect: new BunSqliteDialect({ database: new BunDatabase(":memory:") }),
    });
    // Full forward replay of every on-disk migration (the #2785
    // destructive-recovery path). Proves the migration is discovered/wired
    // against the real observation-table schema.
    await runMigrations(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("both composite indexes exist after a fresh full migration chain", async () => {
    for (const table of TABLES) {
      expect(await indexExists(db, indexFor(table))).toBe(true);
      expect(await indexColumns(db, indexFor(table))).toEqual(["build_key_id", "last_seen_at"]);
    }
  });
});
