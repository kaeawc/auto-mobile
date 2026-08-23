import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { runMigrations } from "../../src/db/migrator";
import type { Database } from "../../src/db/types";
import {
  buildOldestEdgeEvictableQuery,
  buildOldestNodeEvictableQuery,
} from "../../src/db/navigationRetention";
import {
  down as evictionDown,
  up as evictionUp,
} from "../../src/db/migrations/2026_08_22_002_navigation_observation_eviction_index";

/**
 * Migration coverage for #5309. The size-cap eviction pass in
 * `src/db/navigationRetention.ts` reads the `limit` oldest rows of
 * `navigation_node_observations` / `navigation_edge_observations`
 * `ORDER BY last_seen_at ASC, id ASC` — GLOBALLY across every build key (app
 * scope, when present, is a `build_key_id IN (…)` filter, not an equality). With
 * only the #4986 single-column `idx_navigation_<t>_observations_build
 * (build_key_id)` the planner must `USE TEMP B-TREE FOR ORDER BY` to satisfy that
 * `last_seen_at` ordering.
 *
 * This migration adds `(last_seen_at, id)` — leading with the ordering column —
 * so the planner reads rows in order straight from the index and stops at `limit`,
 * an index range scan instead of scan + sort. A leading-`build_key_id` composite
 * (`(build_key_id, last_seen_at)`) would NOT remove the sort, because the outer
 * ordering is across build keys, not within one — so these tests compile the REAL
 * eviction query builders (not a synthetic per-key query) and assert the temp
 * B-tree is gone for the global, app-scoped, and active-exclusion shapes.
 *
 * They also pin: the index exists on both tables with ordered columns
 * `[last_seen_at, id]`, oldest-first reads are unchanged, the migration is
 * discovered by a full replay, is idempotent / reversible / replay-safe, and does
 * not disturb the retained single-column build index (which still seeks the
 * correlated per-build-key MAX exclusion subquery).
 */
const TABLES = ["navigation_node_observations", "navigation_edge_observations"] as const;
const indexFor = (table: string): string => `idx_${table}_seen_id`;
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
  return result.rows.map((r) => r.name);
}

/**
 * Minimal reproduction of the observation-table schema the eviction queries
 * touch, plus the #4986 single-column build index and the build-key lookup table
 * the app-scoped query joins. Seeded with a spread of build keys / apps and then
 * ANALYZE-d so the planner has the row statistics it uses in production — index
 * selection for the app-scoped `build_key_id IN (…)` filter is stats-driven.
 * Index selection depends only on these columns, so the focused tests stay
 * decoupled from the full navigation migration chain; the full-replay block below
 * proves wiring against the real schema.
 */
async function buildPreMigrationSchema(bunDb: BunDatabase, db: Kysely<unknown>): Promise<void> {
  for (const table of TABLES) {
    await db.schema
      .createTable(table)
      .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
      .addColumn("build_key_id", "integer", (col) => col.notNull())
      .addColumn("last_seen_at", "integer", (col) => col.notNull())
      .execute();
    await db.schema.createIndex(buildIndexFor(table)).on(table).column("build_key_id").execute();
  }
  await db.schema
    .createTable("navigation_build_keys")
    .addColumn("id", "integer", (col) => col.primaryKey())
    .addColumn("app_id", "text")
    .execute();

  const insertNode = bunDb.prepare(
    "INSERT INTO navigation_node_observations (build_key_id, last_seen_at) VALUES (?, ?)",
  );
  const insertEdge = bunDb.prepare(
    "INSERT INTO navigation_edge_observations (build_key_id, last_seen_at) VALUES (?, ?)",
  );
  const seed = bunDb.transaction((rows: number) => {
    for (let i = 0; i < rows; i++) {
      insertNode.run(i % 30, (i * 37) % 100000);
      insertEdge.run(i % 30, (i * 41) % 100000);
    }
  });
  seed(3000);
  const insertKey = bunDb.prepare("INSERT INTO navigation_build_keys (id, app_id) VALUES (?, ?)");
  for (let i = 0; i < 30; i++) {
    insertKey.run(i, `app${i % 4}`);
  }
  bunDb.run("ANALYZE");
}

/** EXPLAIN QUERY PLAN detail lines (newline-joined) for a compiled kysely query. */
function planFor(
  bunDb: BunDatabase,
  compiled: { sql: string; parameters: readonly unknown[] },
): string {
  const rows = bunDb
    .query(`EXPLAIN QUERY PLAN ${compiled.sql}`)
    .all(...(compiled.parameters as unknown[])) as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join("\n");
}

const TEMP_SORT = "USE TEMP B-TREE FOR ORDER BY";

interface EvictionCase {
  label: string;
  table: string;
  sql: { sql: string; parameters: readonly unknown[] };
}

/**
 * The three query shapes `collectOldestEvictable` issues, built from the REAL
 * exported query builders: global eviction (`appId === null`), per-app eviction
 * (`build_key_id IN (<app's keys>)`), and active-row exclusion (correlated
 * per-build-key MAX). Each is exercised against both observation tables.
 */
function evictionCases(db: Kysely<Database>): EvictionCase[] {
  return [
    {
      label: "node global",
      table: "navigation_node_observations",
      sql: buildOldestNodeEvictableQuery(db, null, [], 500).compile(),
    },
    {
      label: "node app-scoped",
      table: "navigation_node_observations",
      sql: buildOldestNodeEvictableQuery(db, "app1", [], 500).compile(),
    },
    {
      label: "node protected",
      table: "navigation_node_observations",
      sql: buildOldestNodeEvictableQuery(db, null, [5, 7], 500).compile(),
    },
    {
      label: "edge global",
      table: "navigation_edge_observations",
      sql: buildOldestEdgeEvictableQuery(db, null, [], 500).compile(),
    },
    {
      label: "edge app-scoped",
      table: "navigation_edge_observations",
      sql: buildOldestEdgeEvictableQuery(db, "app1", [], 500).compile(),
    },
    {
      label: "edge protected",
      table: "navigation_edge_observations",
      sql: buildOldestEdgeEvictableQuery(db, null, [5, 7], 500).compile(),
    },
  ];
}

describe("2026_08_22_002_navigation_observation_eviction_index migration", () => {
  let bunDb: BunDatabase;
  let db: Kysely<Database>;

  beforeEach(async () => {
    bunDb = new BunDatabase(":memory:");
    db = new Kysely<Database>({ dialect: new BunSqliteDialect({ database: bunDb }) });
    await buildPreMigrationSchema(bunDb, db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("up creates the (last_seen_at, id) eviction index on both tables in order", async () => {
    for (const table of TABLES) {
      expect(await indexExists(db, indexFor(table))).toBe(false);
    }

    await evictionUp(db);

    for (const table of TABLES) {
      expect(await indexExists(db, indexFor(table))).toBe(true);
      expect(await indexColumns(db, indexFor(table))).toEqual(["last_seen_at", "id"]);
    }
  });

  test("the real global eviction queries temp-sort before the migration", () => {
    for (const c of evictionCases(db).filter((c) => c.label.endsWith("global"))) {
      expect(planFor(bunDb, c.sql)).toContain(TEMP_SORT);
    }
  });

  test("every real eviction query drops the temp sort onto the index after migration", async () => {
    await evictionUp(db);
    // Refresh stats so the planner accounts for the new index on the app-scoped
    // filter (mirrors a production DB that has ANALYZE-d since the index landed).
    bunDb.run("ANALYZE");

    for (const c of evictionCases(db)) {
      const plan = planFor(bunDb, c.sql);
      expect(plan, `${c.label}: ${plan}`).not.toContain(TEMP_SORT);
      expect(plan, `${c.label}: ${plan}`).toContain(indexFor(c.table));
    }
  });

  test("oldest-first eviction read returns the same rows before and after the migration", async () => {
    const read = async (): Promise<Array<{ id: number; last_seen_at: number }>> =>
      buildOldestNodeEvictableQuery(db, null, [], 5).execute();

    const before = await read();
    await evictionUp(db);
    const after = await read();

    expect(after).toEqual(before);
    // Oldest-first: last_seen_at ascending, ties broken by id ascending.
    const seen = after.map((r) => r.last_seen_at);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  test("up is idempotent (safe to re-run, as destructive-recovery replay would)", async () => {
    await evictionUp(db);
    await expect(evictionUp(db)).resolves.toBeUndefined();
    for (const table of TABLES) {
      expect(await indexExists(db, indexFor(table))).toBe(true);
    }
  });

  test("down drops the eviction index on both tables", async () => {
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

  test("both eviction indexes exist after a fresh full migration chain", async () => {
    for (const table of TABLES) {
      expect(await indexExists(db, indexFor(table))).toBe(true);
      expect(await indexColumns(db, indexFor(table))).toEqual(["last_seen_at", "id"]);
    }
  });
});
