import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { up as navigationUp } from "../../src/db/migrations/2025_12_30_001_navigation_graph";
import { up as testCoverageUp } from "../../src/db/migrations/2026_01_08_000_test_coverage";
import {
  up as edgeIndexUp,
  down as edgeIndexDown,
} from "../../src/db/migrations/2026_10_05_002_test_edge_coverage_edge_id_index";

describe("2026_10_05_002_test_edge_coverage_edge_id_index migration", () => {
  let bunDb: BunDatabase;
  let db: Kysely<unknown>;

  beforeEach(async () => {
    bunDb = new BunDatabase(":memory:");
    db = new Kysely<unknown>({ dialect: new BunSqliteDialect({ database: bunDb }) });
    await navigationUp(db);
    await testCoverageUp(db);
  });
  afterEach(async () => {
    await db.destroy();
  });

  function edgeLookupPlan(): string {
    return bunDb
      .query<{ detail: string }, []>(
        "EXPLAIN QUERY PLAN SELECT 1 FROM test_edge_coverage c WHERE c.edge_id = 1",
      )
      .all()
      .map((row) => row.detail)
      .join("\n");
  }

  function indexes(): string[] {
    return bunDb
      .query<{ name: string }, []>("SELECT name FROM pragma_index_list('test_edge_coverage')")
      .all()
      .map((row) => row.name);
  }

  test("the retention probe has no edge index before migration", () => {
    expect(indexes()).not.toContain("idx_test_edge_coverage_edge");
    expect(edgeLookupPlan()).not.toContain("idx_test_edge_coverage_edge");
  });

  test("the edge index serves the retention probe", async () => {
    await edgeIndexUp(db);
    expect(indexes()).toContain("idx_test_edge_coverage_edge");
    expect(edgeLookupPlan()).toContain("idx_test_edge_coverage_edge");
  });

  test("up and down are idempotent and down preserves the original indexes", async () => {
    await edgeIndexUp(db);
    await edgeIndexUp(db);
    await edgeIndexDown(db);
    await edgeIndexDown(db);
    expect(indexes()).toContain("idx_test_edge_coverage_session_edge");
    expect(indexes()).toContain("idx_test_edge_coverage_session");
    expect(indexes()).not.toContain("idx_test_edge_coverage_edge");
  });
});
