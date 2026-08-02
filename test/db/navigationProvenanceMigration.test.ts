import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import type { Database } from "../../src/db/types";
import { up as navGraphUp } from "../../src/db/migrations/2025_12_30_001_navigation_graph";
import {
  up as provenanceUp,
  down as provenanceDown,
} from "../../src/db/migrations/2026_08_02_000_navigation_provenance";

/**
 * Migration coverage for #4984 Phase 1 (nav (app,build) provenance).
 *
 * Builds the base navigation schema, seeds legacy single-build nodes/edges, then
 * runs the provenance migration and asserts AC1 (build-key + observation tables)
 * and AC4 (backward-compatible backfill: existing rows map to a DEFAULT build key
 * with non-null sentinels, no data loss). foreign_keys is ON so the FK/cascade
 * wiring is exercised for real.
 */
describe("2026_08_02_000_navigation_provenance migration", () => {
  let bunDb: BunDatabase;
  let db: Kysely<Database>;

  beforeEach(async () => {
    bunDb = new BunDatabase(":memory:");
    bunDb.exec("PRAGMA foreign_keys = ON;");
    db = new Kysely<Database>({ dialect: new BunSqliteDialect({ database: bunDb }) });
    await navGraphUp(db as unknown as Kysely<unknown>);
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedLegacyGraph(): Promise<void> {
    await db.insertInto("navigation_apps").values({ app_id: "com.example.app", updated_at: "2026-01-01T00:00:00.000Z" }).execute();
    await db
      .insertInto("navigation_nodes")
      .values([
        { app_id: "com.example.app", screen_name: "Home", first_seen_at: 100, last_seen_at: 200, visit_count: 2 },
        { app_id: "com.example.app", screen_name: "Details", first_seen_at: 150, last_seen_at: 150, visit_count: 1 },
      ])
      .execute();
    await db
      .insertInto("navigation_edges")
      .values([
        { app_id: "com.example.app", from_screen: "Home", to_screen: "Details", tool_name: "tapOn", tool_args: null, timestamp: 150 },
      ])
      .execute();
  }

  async function tableNames(): Promise<string[]> {
    const rows = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`.execute(db);
    return rows.rows.map(r => r.name);
  }

  test("AC1: creates build-key + node/edge observation tables", async () => {
    await provenanceUp(db as unknown as Kysely<unknown>);
    const names = await tableNames();
    expect(names).toContain("navigation_build_keys");
    expect(names).toContain("navigation_node_observations");
    expect(names).toContain("navigation_edge_observations");
  });

  test("AC4: backfills a default build key + one observation per existing node/edge (no data loss)", async () => {
    await seedLegacyGraph();
    await provenanceUp(db as unknown as Kysely<unknown>);

    // Existing rows are untouched.
    const nodes = await db.selectFrom("navigation_nodes").selectAll().execute();
    const edges = await db.selectFrom("navigation_edges").selectAll().execute();
    expect(nodes).toHaveLength(2);
    expect(edges).toHaveLength(1);

    // One default build key per app, with non-null sentinels (version_code=0, content_hash='').
    const buildKeys = await db.selectFrom("navigation_build_keys").selectAll().execute();
    expect(buildKeys).toHaveLength(1);
    expect(buildKeys[0].app_id).toBe("com.example.app");
    expect(buildKeys[0].version_code).toBe(0);
    expect(buildKeys[0].content_hash).toBe("");

    // One node observation per node, carrying legacy sentinels + source timestamps.
    const nodeObs = await db
      .selectFrom("navigation_node_observations")
      .selectAll()
      .orderBy("node_id", "asc")
      .execute();
    expect(nodeObs).toHaveLength(2);
    for (const o of nodeObs) {
      expect(o.build_key_id).toBe(buildKeys[0].id);
      expect(o.device_id).toBe("legacy");
      expect(o.session_uuid).toBe("legacy");
    }
    const home = nodes.find(n => n.screen_name === "Home")!;
    const homeObs = nodeObs.find(o => o.node_id === home.id)!;
    expect(homeObs.first_seen_at).toBe(100);
    expect(homeObs.last_seen_at).toBe(200);

    // One edge observation per edge, using the edge timestamp for both seen fields.
    const edgeObs = await db.selectFrom("navigation_edge_observations").selectAll().execute();
    expect(edgeObs).toHaveLength(1);
    expect(edgeObs[0].edge_id).toBe(edges[0].id);
    expect(edgeObs[0].build_key_id).toBe(buildKeys[0].id);
    expect(edgeObs[0].device_id).toBe("legacy");
    expect(edgeObs[0].session_uuid).toBe("legacy");
    expect(edgeObs[0].first_seen_at).toBe(150);
    expect(edgeObs[0].last_seen_at).toBe(150);
  });

  test("up() is idempotent / retry-safe (re-running does not violate UNIQUE)", async () => {
    // SqliteAdapter is non-transactional-DDL, so a failed backfill reruns up() from
    // the top on restart. Re-running must not throw a duplicate-key error, and must
    // not duplicate the backfilled rows.
    await seedLegacyGraph();
    await provenanceUp(db as unknown as Kysely<unknown>);
    await provenanceUp(db as unknown as Kysely<unknown>); // rerun

    expect(await db.selectFrom("navigation_build_keys").selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom("navigation_node_observations").selectAll().execute()).toHaveLength(2);
    expect(await db.selectFrom("navigation_edge_observations").selectAll().execute()).toHaveLength(1);
  });

  test("down() drops the provenance tables", async () => {
    await provenanceUp(db as unknown as Kysely<unknown>);
    await provenanceDown(db as unknown as Kysely<unknown>);
    const names = await tableNames();
    expect(names).not.toContain("navigation_build_keys");
    expect(names).not.toContain("navigation_node_observations");
    expect(names).not.toContain("navigation_edge_observations");
  });
});
