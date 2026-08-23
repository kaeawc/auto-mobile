import { beforeEach, afterEach, describe, expect, test } from "bun:test";
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
