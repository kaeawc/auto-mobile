import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database, NewRecompositionMetrics } from "../../src/db/types";
import { RecompositionMetricsRepository } from "../../src/db/recompositionMetricsRepository";
import { createTestDatabase } from "./testDbHelper";

function row(id: string, timestamp: string): NewRecompositionMetrics {
  return {
    device_id: "emulator-5554",
    session_id: "2026-10-18",
    package_name: "com.example",
    composable_id: id,
    composable_name: null,
    resource_id: null,
    test_tag: null,
    total_count: 1,
    skip_count: 0,
    rolling_1s_avg: 0,
    duration_ms: null,
    likely_cause: null,
    parent_chain_json: null,
    stable_annotated: null,
    remembered_count: null,
    timestamp,
  };
}

describe("RecompositionMetricsRepository", () => {
  let db: Kysely<Database>;
  let repo: RecompositionMetricsRepository;

  beforeEach(async () => {
    db = await createTestDatabase();
    repo = new RecompositionMetricsRepository({ resolveDatabase: () => db });
  });

  afterEach(async () => {
    await db.destroy();
  });

  const ids = async () =>
    (
      await db
        .selectFrom("recomposition_metrics")
        .select("composable_id")
        .orderBy("timestamp")
        .execute()
    ).map((r) => r.composable_id);

  test("insertMany stores rows and ignores an empty batch", async () => {
    await repo.insertMany([]);
    expect(await ids()).toEqual([]);
    await repo.insertMany([
      row("a", "2026-01-01T00:00:01.000Z"),
      row("b", "2026-01-01T00:00:02.000Z"),
    ]);
    expect(await ids()).toEqual(["a", "b"]);
  });

  test("pruneToMaxRows deletes the oldest rows beyond the cap", async () => {
    await repo.insertMany([
      row("c", "2026-01-01T00:00:03.000Z"),
      row("a", "2026-01-01T00:00:01.000Z"),
      row("b", "2026-01-01T00:00:02.000Z"),
    ]);
    await repo.pruneToMaxRows(5);
    expect(await ids()).toEqual(["a", "b", "c"]);
    await repo.pruneToMaxRows(2);
    expect(await ids()).toEqual(["b", "c"]);
  });
});
