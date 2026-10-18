import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "./testDbHelper";
import {
  getFailureBackfillRows,
  getNavigationNodesByScreenNames,
} from "../../src/db/telemetryBackfillRepository";

describe("telemetryBackfillRepository", () => {
  let db: Kysely<Database>;

  beforeAll(async () => {
    const template = await createTestDatabase();
    await template.destroy();
  });
  beforeEach(async () => {
    db = await createTestDatabase();
  });
  afterEach(async () => {
    await db.destroy();
  });

  const seedFailure = async (
    id: string,
    type: "crash" | "anr",
    timestamp: number,
    deviceId: string | null,
    sessionId: string,
  ) => {
    await db
      .insertInto("failure_groups")
      .values({
        id,
        type,
        signature: id,
        title: id,
        message: "boom",
        severity: "critical",
        first_occurrence: 1,
        last_occurrence: 1,
        total_count: 1,
        unique_sessions: 1,
        stack_trace_json: null,
        tool_call_info_json: null,
      })
      .execute();
    await db
      .insertInto("failure_occurrences")
      .values({
        id,
        group_id: id,
        timestamp,
        device_id: deviceId,
        device_model: "Pixel",
        os: "34",
        app_version: "1",
        session_id: sessionId,
        screen_at_failure: "Home",
        test_name: null,
        test_execution_id: null,
        error_code: null,
        duration_ms: null,
        tool_args_json: null,
      })
      .execute();
  };

  test("getNavigationNodesByScreenNames returns only matching screens", async () => {
    await db.insertInto("navigation_apps").values({ app_id: "com.example" }).execute();
    for (const screen_name of ["Home", "Settings"]) {
      await db
        .insertInto("navigation_nodes")
        .values({
          app_id: "com.example",
          screen_name,
          first_seen_at: 1,
          last_seen_at: 1,
          visit_count: 1,
        })
        .execute();
    }
    const nodes = await getNavigationNodesByScreenNames(["Home"], db);
    expect(nodes.map((n) => [n.app_id, n.screen_name])).toEqual([["com.example", "Home"]]);
  });

  test("getFailureBackfillRows filters by type, drops device-less rows, orders newest first", async () => {
    await seedFailure("old", "crash", 1, "d1", "s1");
    await seedFailure("new", "crash", 2, "d1", "s2");
    await seedFailure("nodevice", "crash", 3, null, "s1");
    await seedFailure("anr", "anr", 4, "d1", "s1");

    const rows = await getFailureBackfillRows({ failureType: "crash", limit: 10 }, db);
    expect(rows.map((r) => r.occurrenceId)).toEqual(["new", "old"]);
    expect(rows[0]).toMatchObject({ deviceId: "d1", sessionId: "s2", screen: "Home" });
  });

  test("getFailureBackfillRows applies device, session and limit filters", async () => {
    await seedFailure("a", "crash", 1, "d1", "s1");
    await seedFailure("b", "crash", 2, "d1", "s2");
    await seedFailure("c", "crash", 3, "d2", "s1");

    const bySession = await getFailureBackfillRows(
      { failureType: "crash", deviceId: "d1", sessionId: "s1", limit: 10 },
      db,
    );
    expect(bySession.map((r) => r.occurrenceId)).toEqual(["a"]);
    const limited = await getFailureBackfillRows({ failureType: "crash", limit: 1 }, db);
    expect(limited.map((r) => r.occurrenceId)).toEqual(["c"]);
  });
});
