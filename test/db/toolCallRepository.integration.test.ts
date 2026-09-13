import { beforeEach, afterEach, describe, expect, spyOn, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { ToolCallRepository } from "../../src/db/toolCallRepository";
import { createTestDatabase } from "./testDbHelper";

describe("ToolCallRepository", () => {
  let db: Kysely<Database>;
  let repo: ToolCallRepository;

  beforeEach(async () => {
    db = await createTestDatabase();
    repo = new ToolCallRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("recordToolCall inserts a tool call", async () => {
    await repo.recordToolCall({
      toolName: "tapOn",
      timestamp: "2024-01-01T00:00:00.000Z",
      sessionUuid: "session-1",
      durationMs: 42,
    });

    const rows = await db.selectFrom("tool_calls").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].tool_name).toBe("tapOn");
    expect(rows[0].timestamp).toBe("2024-01-01T00:00:00.000Z");
    expect(rows[0].session_uuid).toBe("session-1");
    expect(rows[0].duration_ms).toBe(42);
  });

  test("recordToolCall with null session uuid", async () => {
    await repo.recordToolCall({
      toolName: "observe",
      timestamp: "2024-01-01T00:00:00.000Z",
    });

    const rows = await db.selectFrom("tool_calls").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].session_uuid).toBeNull();
  });

  test("listToolNamesBetween returns unique tool names in order", async () => {
    await repo.recordToolCall({ toolName: "tapOn", timestamp: "2024-01-01T00:00:01.000Z" });
    await repo.recordToolCall({ toolName: "observe", timestamp: "2024-01-01T00:00:02.000Z" });
    await repo.recordToolCall({ toolName: "tapOn", timestamp: "2024-01-01T00:00:03.000Z" });

    const result = await repo.listToolNamesBetween(
      "2024-01-01T00:00:00.000Z",
      "2024-01-01T00:00:04.000Z",
    );
    expect(result).toEqual(["tapOn", "observe"]);
  });

  test("listToolNamesBetween filters by time range", async () => {
    await repo.recordToolCall({ toolName: "early", timestamp: "2024-01-01T00:00:01.000Z" });
    await repo.recordToolCall({ toolName: "middle", timestamp: "2024-01-01T00:00:05.000Z" });
    await repo.recordToolCall({ toolName: "late", timestamp: "2024-01-01T00:00:10.000Z" });

    const result = await repo.listToolNamesBetween(
      "2024-01-01T00:00:03.000Z",
      "2024-01-01T00:00:07.000Z",
    );
    expect(result).toEqual(["middle"]);
  });

  test("listToolNamesBetween excludes specified tools", async () => {
    await repo.recordToolCall({ toolName: "tapOn", timestamp: "2024-01-01T00:00:01.000Z" });
    await repo.recordToolCall({ toolName: "observe", timestamp: "2024-01-01T00:00:02.000Z" });
    await repo.recordToolCall({ toolName: "inputText", timestamp: "2024-01-01T00:00:03.000Z" });

    const result = await repo.listToolNamesBetween(
      "2024-01-01T00:00:00.000Z",
      "2024-01-01T00:00:04.000Z",
      ["observe"],
    );
    expect(result).toEqual(["tapOn", "inputText"]);
  });

  test("listToolNamesBetween returns empty for no matches", async () => {
    const result = await repo.listToolNamesBetween(
      "2024-01-01T00:00:00.000Z",
      "2024-01-01T00:00:04.000Z",
    );
    expect(result).toEqual([]);
  });

  // Regression for #3438: dedup/order pushed into SQL (GROUP BY tool_name
  // ORDER BY MIN(timestamp), MIN(id)). A name is ordered by its FIRST
  // occurrence, so re-appearing later must not move it.
  test("listToolNamesBetween orders by first appearance, not last", async () => {
    await repo.recordToolCall({ toolName: "alpha", timestamp: "2024-01-01T00:00:01.000Z" });
    await repo.recordToolCall({ toolName: "beta", timestamp: "2024-01-01T00:00:02.000Z" });
    await repo.recordToolCall({ toolName: "alpha", timestamp: "2024-01-01T00:00:09.000Z" });
    await repo.recordToolCall({ toolName: "gamma", timestamp: "2024-01-01T00:00:03.000Z" });

    const result = await repo.listToolNamesBetween(
      "2024-01-01T00:00:00.000Z",
      "2024-01-01T00:00:10.000Z",
    );
    expect(result).toEqual(["alpha", "beta", "gamma"]);
  });

  // When two names share their earliest timestamp, the monotonic id breaks the
  // tie (MIN(id)) — matching the prior JS timestamp-asc, id-asc dedup.
  test("listToolNamesBetween breaks same-timestamp ties by insertion order", async () => {
    const ts = "2024-01-01T00:00:05.000Z";
    await repo.recordToolCall({ toolName: "first", timestamp: ts });
    await repo.recordToolCall({ toolName: "second", timestamp: ts });
    await repo.recordToolCall({ toolName: "third", timestamp: ts });

    const result = await repo.listToolNamesBetween(
      "2024-01-01T00:00:00.000Z",
      "2024-01-01T00:00:10.000Z",
    );
    expect(result).toEqual(["first", "second", "third"]);
  });

  test("listToolNamesBetween is inclusive of the start and end bounds", async () => {
    await repo.recordToolCall({ toolName: "atStart", timestamp: "2024-01-01T00:00:00.000Z" });
    await repo.recordToolCall({ toolName: "atEnd", timestamp: "2024-01-01T00:00:04.000Z" });

    const result = await repo.listToolNamesBetween(
      "2024-01-01T00:00:00.000Z",
      "2024-01-01T00:00:04.000Z",
    );
    expect(result).toEqual(["atStart", "atEnd"]);
  });

  test("listToolNamesBetween with an empty exclude list returns all distinct names", async () => {
    await repo.recordToolCall({ toolName: "one", timestamp: "2024-01-01T00:00:01.000Z" });
    await repo.recordToolCall({ toolName: "two", timestamp: "2024-01-01T00:00:02.000Z" });

    const result = await repo.listToolNamesBetween(
      "2024-01-01T00:00:00.000Z",
      "2024-01-01T00:00:04.000Z",
      [],
    );
    expect(result).toEqual(["one", "two"]);
  });

  test("listToolNamesBetween excludes multiple tools at once", async () => {
    await repo.recordToolCall({ toolName: "keep1", timestamp: "2024-01-01T00:00:01.000Z" });
    await repo.recordToolCall({ toolName: "drop1", timestamp: "2024-01-01T00:00:02.000Z" });
    await repo.recordToolCall({ toolName: "keep2", timestamp: "2024-01-01T00:00:03.000Z" });
    await repo.recordToolCall({ toolName: "drop2", timestamp: "2024-01-01T00:00:04.000Z" });

    const result = await repo.listToolNamesBetween(
      "2024-01-01T00:00:00.000Z",
      "2024-01-01T00:00:05.000Z",
      ["drop1", "drop2"],
    );
    expect(result).toEqual(["keep1", "keep2"]);
  });
});

// Regression for #6464: `tool_calls` received one insert per MCP tool call for
// the life of the process with no cap and no scheduled cleanup. These tests
// prove the row-cap retention wired directly into `recordToolCall` — the real
// production write path (`toolRegistry.ts`) — actually bounds the table.
describe("ToolCallRepository row-cap retention (#6464)", () => {
  test("sweeps on the first write of each lifetime and then after 256 more writes", async () => {
    for (let lifetime = 0; lifetime < 2; lifetime++) {
      const fresh = new ToolCallRepository(db);
      const prune = spyOn(fresh as any, "pruneToRowCap");
      try {
        await fresh.recordToolCall({ toolName: "first", timestamp: "2026-01-01T00:00:00Z" });
        expect(prune).toHaveBeenCalledTimes(1);
        for (let index = 0; index < 255; index++) {
          await fresh.recordToolCall({ toolName: "next", timestamp: "2026-01-01T00:00:00Z" });
        }
        expect(prune).toHaveBeenCalledTimes(1);
        await fresh.recordToolCall({ toolName: "last", timestamp: "2026-01-01T00:00:00Z" });
        expect(prune).toHaveBeenCalledTimes(2);
      } finally {
        prune.mockRestore();
      }
    }
  });

  let db: Kysely<Database>;
  let repo: ToolCallRepository;

  beforeEach(async () => {
    db = await createTestDatabase();
    repo = new ToolCallRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("pruneToRowCap trims to exactly the cap, keeping the newest rows by (timestamp, id)", async () => {
    for (let i = 1; i <= 12; i++) {
      await repo.recordToolCall({
        toolName: `tool-${i}`,
        timestamp: `2024-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
      });
    }

    await (repo as any).pruneToRowCap(5);

    const rows = await db
      .selectFrom("tool_calls")
      .select("tool_name")
      .orderBy("timestamp", "asc")
      .execute();
    expect(rows.map((r) => r.tool_name)).toEqual([
      "tool-8",
      "tool-9",
      "tool-10",
      "tool-11",
      "tool-12",
    ]);
  });

  test("pruneToRowCap under the cap deletes nothing (count(*) gate short-circuits)", async () => {
    for (let i = 1; i <= 3; i++) {
      await repo.recordToolCall({
        toolName: `tool-${i}`,
        timestamp: `2024-01-01T00:00:0${i}.000Z`,
      });
    }

    await (repo as any).pruneToRowCap(10);

    const rows = await db.selectFrom("tool_calls").selectAll().execute();
    expect(rows).toHaveLength(3);
  });

  // The row-cap retention must trim rows written via the REAL production
  // write path — status left unset, matching real call sites (#6464) — not a
  // hand-built fixture that sets `status` directly.
  test("row-cap retention bounds rows inserted with status left unset (the real recordToolCall shape)", async () => {
    for (let i = 1; i <= 6; i++) {
      await repo.recordToolCall({
        toolName: `tool-${i}`,
        timestamp: `2024-01-01T00:00:0${i}.000Z`,
      });
    }
    // `status` defaults to "success" at the schema level when the real write
    // path (`recordToolCall`) omits it — never "failure" or NULL.
    const beforePrune = await db.selectFrom("tool_calls").selectAll().execute();
    expect(beforePrune.every((row) => row.status === "success")).toBe(true);

    await (repo as any).pruneToRowCap(2);

    const rows = await db
      .selectFrom("tool_calls")
      .select("tool_name")
      .orderBy("timestamp", "asc")
      .execute();
    expect(rows.map((r) => r.tool_name)).toEqual(["tool-5", "tool-6"]);
  });
});
