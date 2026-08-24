import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import type { Database } from "../../src/db/types";
import { up as failuresUp } from "../../src/db/migrations/2026_01_27_000_failures";
import {
  up as uniqueUp,
  down as uniqueDown,
} from "../../src/db/migrations/2026_07_01_000_failure_groups_signature_unique";

/**
 * Migration coverage for #2789. Builds the failures schema WITH the original
 * non-unique signature index (so duplicate-signature rows can be seeded), then
 * runs the de-dup + UNIQUE-index migration and asserts the invariants the issue
 * calls out: FK-safe repoint-before-delete, notification orphan avoidance,
 * deterministic keeper tiebreak, count backfill, idempotency, and enforcement.
 *
 * foreign_keys is ON to match the production connection so the cascade-ordering
 * hazard is real: a delete-first migration would cascade-wipe the occurrences.
 */
describe("2026_07_01_000_failure_groups_signature_unique migration", () => {
  let bunDb: BunDatabase;
  let db: Kysely<Database>;

  beforeEach(async () => {
    bunDb = new BunDatabase(":memory:");
    bunDb.exec("PRAGMA foreign_keys = ON;");
    db = new Kysely<Database>({
      dialect: new BunSqliteDialect({ database: bunDb }),
    });
    // Base failures schema: non-unique idx_failure_groups_signature.
    await failuresUp(db as unknown as Kysely<unknown>);
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function seedGroup(overrides: {
    id: string;
    signature: string;
    firstOccurrence: number;
    totalCount: number;
    uniqueSessions: number;
    lastOccurrence?: number;
    type?: string;
  }): Promise<void> {
    await db
      .insertInto("failure_groups")
      .values({
        id: overrides.id,
        type: overrides.type ?? "crash",
        signature: overrides.signature,
        title: "t",
        message: "m",
        severity: "critical",
        first_occurrence: overrides.firstOccurrence,
        last_occurrence: overrides.lastOccurrence ?? overrides.firstOccurrence,
        total_count: overrides.totalCount,
        unique_sessions: overrides.uniqueSessions,
        stack_trace_json: null,
        tool_call_info_json: null,
        updated_at: "2026-07-01T00:00:00.000Z",
      })
      .execute();
  }

  async function seedOccurrence(id: string, groupId: string, sessionId: string): Promise<void> {
    await db
      .insertInto("failure_occurrences")
      .values({
        id,
        group_id: groupId,
        timestamp: 1000,
        device_id: null,
        device_model: "Pixel 7",
        os: "Android 14",
        app_version: "1.0.0",
        session_id: sessionId,
        screen_at_failure: null,
        test_name: null,
        test_execution_id: null,
        error_code: null,
        duration_ms: null,
        tool_args_json: null,
      })
      .execute();
  }

  async function seedNotification(occurrenceId: string, groupId: string): Promise<void> {
    await db
      .insertInto("failure_notifications")
      .values({
        occurrence_id: occurrenceId,
        group_id: groupId,
        type: "crash",
        severity: "critical",
        title: "t",
        timestamp: 1000,
        acknowledged: 0,
      })
      .execute();
  }

  test("collapses duplicate-signature groups into the earliest keeper and repoints occurrences (FK-safe)", async () => {
    // Keeper A (earlier first_occurrence) and loser B share a signature. B has a
    // MORE RECENT last_occurrence, which the keeper must inherit so the dashboard
    // (ordered by last_occurrence) does not sort the collapsed group as stale.
    await seedGroup({
      id: "A",
      signature: "sig-x",
      firstOccurrence: 100,
      lastOccurrence: 150,
      totalCount: 3,
      uniqueSessions: 2,
    });
    await seedGroup({
      id: "B",
      signature: "sig-x",
      firstOccurrence: 200,
      lastOccurrence: 900,
      totalCount: 2,
      uniqueSessions: 2,
    });
    // A has sessions s1, s2; B has sessions s2, s3.
    await seedOccurrence("occ-a1", "A", "s1");
    await seedOccurrence("occ-a2", "A", "s2");
    await seedOccurrence("occ-b1", "B", "s2");
    await seedOccurrence("occ-b2", "B", "s3");
    await seedNotification("occ-a1", "A");
    await seedNotification("occ-b1", "B");

    await uniqueUp(db as unknown as Kysely<unknown>);

    const groups = await db.selectFrom("failure_groups").selectAll().execute();
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("A");
    // total_count is the SUM of the duplicate groups' historical counts.
    expect(groups[0].total_count).toBe(5);
    // last_occurrence is the MAX across duplicates (B's 900), not the keeper's own.
    expect(groups[0].last_occurrence).toBe(900);
    // unique_sessions is DERIVED from the surviving occurrences: {s1, s2, s3}.
    expect(groups[0].unique_sessions).toBe(3);

    // Every occurrence survived (delete-first would have cascade-wiped B's) and
    // now points at the keeper.
    const occurrences = await db.selectFrom("failure_occurrences").selectAll().execute();
    expect(occurrences).toHaveLength(4);
    expect(occurrences.every((o) => o.group_id === "A")).toBe(true);
  });

  test("repoints failure_notifications so zero rows reference a non-existent group", async () => {
    await seedGroup({
      id: "A",
      signature: "sig-x",
      firstOccurrence: 100,
      totalCount: 1,
      uniqueSessions: 1,
    });
    await seedGroup({
      id: "B",
      signature: "sig-x",
      firstOccurrence: 200,
      totalCount: 1,
      uniqueSessions: 1,
    });
    await seedOccurrence("occ-a1", "A", "s1");
    await seedOccurrence("occ-b1", "B", "s2");
    await seedNotification("occ-a1", "A");
    await seedNotification("occ-b1", "B");

    await uniqueUp(db as unknown as Kysely<unknown>);

    const notifications = await db.selectFrom("failure_notifications").selectAll().execute();
    expect(notifications).toHaveLength(2);
    // No notification may reference a deleted group id.
    const liveGroupIds = new Set(
      (await db.selectFrom("failure_groups").select("id").execute()).map((g) => g.id),
    );
    for (const n of notifications) {
      expect(liveGroupIds.has(n.group_id)).toBe(true);
    }
  });

  test("uses a deterministic keeper tiebreak (min id) when first_occurrence ties", async () => {
    // Same first_occurrence — keeper must be the min id ("aaa").
    await seedGroup({
      id: "bbb",
      signature: "sig-tie",
      firstOccurrence: 500,
      totalCount: 1,
      uniqueSessions: 1,
    });
    await seedGroup({
      id: "aaa",
      signature: "sig-tie",
      firstOccurrence: 500,
      totalCount: 1,
      uniqueSessions: 1,
    });
    await seedOccurrence("occ-1", "aaa", "s1");
    await seedOccurrence("occ-2", "bbb", "s1");

    await uniqueUp(db as unknown as Kysely<unknown>);

    const groups = await db.selectFrom("failure_groups").selectAll().execute();
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe("aaa");
  });

  test("enforces uniqueness after migration (duplicate-signature insert throws)", async () => {
    await seedGroup({
      id: "A",
      signature: "sig-x",
      firstOccurrence: 100,
      totalCount: 1,
      uniqueSessions: 1,
    });

    await uniqueUp(db as unknown as Kysely<unknown>);

    await expect(
      seedGroup({
        id: "C",
        signature: "sig-x",
        firstOccurrence: 300,
        totalCount: 1,
        uniqueSessions: 1,
      }),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  test("is a no-op safe on an empty database and idempotent when re-run", async () => {
    // Empty DB (no groups): must not throw and must create the unique index.
    await uniqueUp(db as unknown as Kysely<unknown>);
    // Re-running (as #2785's destructive-recovery replay would) must not throw.
    await uniqueUp(db as unknown as Kysely<unknown>);

    // Unique index is present and enforcing.
    await seedGroup({
      id: "A",
      signature: "sig-only",
      firstOccurrence: 1,
      totalCount: 1,
      uniqueSessions: 1,
    });
    await expect(
      seedGroup({
        id: "B",
        signature: "sig-only",
        firstOccurrence: 2,
        totalCount: 1,
        uniqueSessions: 1,
      }),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  test("down() restores the non-unique index so duplicate signatures are allowed again", async () => {
    await seedGroup({
      id: "A",
      signature: "sig-x",
      firstOccurrence: 100,
      totalCount: 1,
      uniqueSessions: 1,
    });
    await uniqueUp(db as unknown as Kysely<unknown>);
    await uniqueDown(db as unknown as Kysely<unknown>);

    // After down, a duplicate signature must be insertable again.
    await seedGroup({
      id: "B",
      signature: "sig-x",
      firstOccurrence: 200,
      totalCount: 1,
      uniqueSessions: 1,
    });
    const groups = await db.selectFrom("failure_groups").selectAll().execute();
    expect(groups).toHaveLength(2);
  });
});
