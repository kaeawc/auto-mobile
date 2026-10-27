import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { ToolCallRepository, boundToolCallErrorMessage } from "../../src/db/toolCallRepository";
import { createTestDatabase } from "./testDbHelper";

describe("ToolCallRepository status recording", () => {
  let db: Kysely<Database>;
  let repository: ToolCallRepository;

  beforeEach(async () => {
    db = await createTestDatabase();
    repository = new ToolCallRepository(db);
  });
  afterEach(async () => {
    await db.destroy();
  });

  test("persists failure details and the resolved device", async () => {
    await repository.recordToolCall({
      toolName: "tapOn",
      timestamp: "2026-10-19T00:00:00Z",
      status: "failure",
      errorType: "ActionableError",
      errorMessage: "No target\n found",
      deviceId: "emulator-5554",
    });
    const row = await db.selectFrom("tool_calls").selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      status: "failure",
      error_type: "ActionableError",
      error_message: "No target\n found",
      device_id: "emulator-5554",
    });
  });

  test("defaults to success with null error and device columns", async () => {
    await repository.recordToolCall({ toolName: "observe", timestamp: "2026-10-19T00:00:00Z" });
    const row = await db.selectFrom("tool_calls").selectAll().executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      status: "success",
      error_type: null,
      error_message: null,
      device_id: null,
    });
  });

  test("bounds persisted messages including the ellipsis", async () => {
    await repository.recordToolCall({
      toolName: "observe",
      timestamp: "2026-10-19T00:00:00Z",
      status: "failure",
      errorMessage: "x".repeat(600),
    });
    const row = await db.selectFrom("tool_calls").selectAll().executeTakeFirstOrThrow();
    expect(row.error_message).toBe(`${"x".repeat(499)}…`);
  });
});

describe("boundToolCallErrorMessage", () => {
  test("preserves empty, whitespace and messages at the bound", () => {
    for (const message of ["", "line\n  spaced\t", "x".repeat(500)]) {
      expect(boundToolCallErrorMessage(message)).toBe(message);
    }
  });
  test("keeps the head of messages over the bound", () => {
    expect(boundToolCallErrorMessage(`${"a".repeat(500)}tail`)).toBe(`${"a".repeat(499)}…`);
  });
});
