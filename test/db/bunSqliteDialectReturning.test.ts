import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "./testDbHelper";

/**
 * The BunSqliteDialect hand-rolls RETURNING support: executeQuery only returns
 * rows when the SQL starts with "select" OR includes "returning"
 * (src/db/bunSqliteDialect.ts:165-175). #2789's atomic upsert relies on
 * `.onConflict(...).doUpdateSet(...).returning("id")` yielding the row on BOTH
 * the insert path and the conflict path. This asserts the conflict path returns
 * the PRE-EXISTING id — the untested case the reviews flagged.
 */
describe("BunSqliteDialect RETURNING on upsert conflict path", () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("insert path returns the freshly inserted id", async () => {
    const inserted = await db
      .insertInto("failure_groups")
      .values({
        id: "group-1",
        type: "crash",
        signature: "sig-return",
        title: "t",
        message: "m",
        severity: "critical",
        first_occurrence: 1,
        last_occurrence: 1,
        total_count: 1,
        unique_sessions: 1,
        stack_trace_json: null,
        tool_call_info_json: null,
        updated_at: "2026-07-01T00:00:00.000Z",
      })
      .onConflict((oc) =>
        oc.column("signature").doUpdateSet((eb) => ({
          last_occurrence: 2,
          total_count: eb("failure_groups.total_count", "+", 1),
        })),
      )
      .returning("id")
      .executeTakeFirstOrThrow();

    expect(inserted.id).toBe("group-1");
  });

  test("conflict path returns the pre-existing group id, not the new candidate id", async () => {
    await db
      .insertInto("failure_groups")
      .values({
        id: "existing-id",
        type: "crash",
        signature: "sig-conflict",
        title: "t",
        message: "m",
        severity: "critical",
        first_occurrence: 1,
        last_occurrence: 1,
        total_count: 1,
        unique_sessions: 1,
        stack_trace_json: null,
        tool_call_info_json: null,
        updated_at: "2026-07-01T00:00:00.000Z",
      })
      .execute();

    // Second upsert with a DIFFERENT candidate id but the same signature must
    // conflict and return the ORIGINAL id.
    const upserted = await db
      .insertInto("failure_groups")
      .values({
        id: "candidate-id",
        type: "crash",
        signature: "sig-conflict",
        title: "t2",
        message: "m2",
        severity: "high",
        first_occurrence: 5,
        last_occurrence: 5,
        total_count: 1,
        unique_sessions: 1,
        stack_trace_json: null,
        tool_call_info_json: null,
        updated_at: "2026-07-01T00:00:05.000Z",
      })
      .onConflict((oc) =>
        oc.column("signature").doUpdateSet((eb) => ({
          last_occurrence: 5,
          total_count: eb("failure_groups.total_count", "+", 1),
        })),
      )
      .returning("id")
      .executeTakeFirstOrThrow();

    expect(upserted.id).toBe("existing-id");

    const groups = await db.selectFrom("failure_groups").selectAll().execute();
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("existing-id");
    expect(groups[0].total_count).toBe(2);
    expect(groups[0].last_occurrence).toBe(5);
  });
});
