import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { up as thresholdsUp } from "../../src/db/migrations/2025_12_30_000_performance_thresholds";
import {
  up as liveMetricsUp,
  down as liveMetricsDown,
} from "../../src/db/migrations/2026_01_30_000_performance_live_metrics";

/**
 * Migration coverage for #6324. The live-metrics migration's `down()` originally
 * called `db.raw(...)` — a method that does not exist on Kysely's `Kysely`
 * instance at runtime; the API is the `sql` template tag (`sql.raw` for dynamic
 * strings). The bug was latent only because no caller wires up rollback today.
 * These tests exercise `down()` end-to-end so the raw-SQL copy/rename path can
 * never silently regress to a non-existent method again.
 */

const LIVE_METRIC_COLUMNS = [
  "time_to_first_frame_ms",
  "time_to_interactive_ms",
  "frame_rate_fps",
  "node_id",
];

async function columnExists(
  db: Kysely<unknown>,
  table: string,
  column: string,
): Promise<boolean> {
  const result = await sql<{ name: string }>`
    SELECT name FROM pragma_table_info(${table}) WHERE name = ${column}
  `.execute(db);
  return result.rows.length > 0;
}

async function indexExists(db: Kysely<unknown>, name: string): Promise<boolean> {
  const result = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'index' AND name = ${name}
  `.execute(db);
  return result.rows.length > 0;
}

describe("2026_01_30_000_performance_live_metrics migration", () => {
  let bunDb: BunDatabase;
  let db: Kysely<unknown>;

  beforeEach(async () => {
    bunDb = new BunDatabase(":memory:");
    db = new Kysely<unknown>({ dialect: new BunSqliteDialect({ database: bunDb }) });
    // Base schema: performance_thresholds + performance_audit_results.
    await thresholdsUp(db);
    await liveMetricsUp(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("up added the live-metric columns and indexes", async () => {
    for (const column of LIVE_METRIC_COLUMNS) {
      expect(await columnExists(db, "performance_audit_results", column)).toBe(true);
    }
    expect(await indexExists(db, "idx_performance_audit_results_node_id")).toBe(true);
    expect(await indexExists(db, "idx_performance_audit_results_package_timestamp")).toBe(true);
  });

  test("down() runs without throwing (raw copy/rename uses sql, not db.raw)", async () => {
    // The regression guard: db.raw does not exist at runtime, so the original
    // down() threw TypeError as soon as the copy step executed.
    await expect(liveMetricsDown(db)).resolves.toBeUndefined();
  });

  test("down() drops the live-metric columns and their indexes", async () => {
    await liveMetricsDown(db);

    for (const column of LIVE_METRIC_COLUMNS) {
      expect(await columnExists(db, "performance_audit_results", column)).toBe(false);
    }
    expect(await indexExists(db, "idx_performance_audit_results_node_id")).toBe(false);
    expect(await indexExists(db, "idx_performance_audit_results_package_timestamp")).toBe(false);
    // The original device+timestamp index is recreated.
    expect(await indexExists(db, "idx_performance_audit_results_device_timestamp")).toBe(true);
  });

  test("down() preserves existing row data through the table rebuild", async () => {
    await sql`
      INSERT INTO performance_audit_results
        (device_id, session_id, package_name, timestamp, passed,
         p50_ms, p95_ms, node_id, frame_rate_fps)
      VALUES
        ('dev-1', 'sess-1', 'com.example', '2026-01-30T00:00:00Z', 1, 12.5, 30.0, 42, 60.0),
        ('dev-2', 'sess-2', 'com.example', '2026-01-30T00:01:00Z', 0, 20.0, 55.0, 7, 45.5)
    `.execute(db);

    await liveMetricsDown(db);

    const rows = await sql<{ device_id: string; session_id: string; passed: number; p50_ms: number }>`
      SELECT device_id, session_id, passed, p50_ms
      FROM performance_audit_results
      ORDER BY device_id
    `.execute(db);

    expect(rows.rows).toEqual([
      { device_id: "dev-1", session_id: "sess-1", passed: 1, p50_ms: 12.5 },
      { device_id: "dev-2", session_id: "sess-2", passed: 0, p50_ms: 20.0 },
    ]);
  });
});
