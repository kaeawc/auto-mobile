import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Kysely } from "kysely";
import { McpTaskRepository } from "../../src/db/mcpTaskRepository";
import { DefaultTaskManager, TASK_INTERRUPTED_MESSAGE } from "../../src/daemon/tasks/TaskManager";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import type { Database } from "../../src/db/types";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import { createTestDatabase } from "./testDbHelper";

const NEW_TASK = {
  taskId: "task-1",
  ownerKey: "key-a",
  toolName: "startDevice",
  instanceId: "instance-1",
  pollIntervalMs: 1_000,
  retentionMs: 600_000,
};

describe("McpTaskRepository (#4668)", () => {
  let db: Kysely<Database>;
  let timer: FakeTimer;
  let repository: McpTaskRepository;

  beforeEach(async () => {
    db = await createTestDatabase();
    timer = new FakeTimer();
    timer.setCurrentTime(10_000);
    repository = new McpTaskRepository({ db, timer });
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("inserts a working task stamped by the injected clock", async () => {
    const created = await repository.insert({ ...NEW_TASK, statusMessage: "Starting" });

    expect(created).toEqual({
      ...NEW_TASK,
      status: "working",
      statusMessage: "Starting",
      createdAtMs: 10_000,
      lastUpdatedAtMs: 10_000,
      terminalAtMs: null,
      expiresAtMs: null,
      inputRequests: null,
      result: null,
      error: null,
    });
    expect(await repository.find("task-1")).toEqual(created);
    expect(await repository.find("missing")).toBeUndefined();
  });

  test("moves between running statuses and keeps fields it was not given", async () => {
    await repository.insert({ ...NEW_TASK, statusMessage: "Starting" });
    timer.advanceTime(5);

    expect(
      await repository.updateRunning("task-1", {
        status: "input_required",
        inputRequests: { a: { method: "elicitation/create" } },
      }),
    ).toBe(true);

    const row = await repository.find("task-1");
    expect(row?.status).toBe("input_required");
    expect(row?.statusMessage).toBe("Starting");
    expect(row?.inputRequests).toEqual({ a: { method: "elicitation/create" } });
    expect(row?.lastUpdatedAtMs).toBe(10_005);
  });

  test("settling sets the terminal instant and expiry once; later writes are fenced", async () => {
    await repository.insert(NEW_TASK);
    timer.advanceTime(2_000);

    expect(
      await repository.settle("task-1", { status: "completed", result: { content: [] } }),
    ).toBe(true);
    expect(await repository.settle("task-1", { status: "cancelled" })).toBe(false);
    expect(await repository.updateRunning("task-1", { status: "working" })).toBe(false);

    const row = await repository.find("task-1");
    expect(row?.status).toBe("completed");
    expect(row?.result).toEqual({ content: [] });
    expect(row?.terminalAtMs).toBe(12_000);
    expect(row?.expiresAtMs).toBe(12_000 + NEW_TASK.retentionMs);
  });

  test("a failed settlement stores the JSON-RPC error", async () => {
    await repository.insert(NEW_TASK);
    await repository.settle("task-1", {
      status: "failed",
      error: { code: -32603, message: "boom" },
      statusMessage: "Tool execution failed: boom",
    });
    const row = await repository.find("task-1");
    expect(row?.error).toEqual({ code: -32603, message: "boom" });
    expect(row?.result).toBeNull();
    expect(row?.statusMessage).toBe("Tool execution failed: boom");
  });

  test("failInterrupted fails only running rows of other instances", async () => {
    await repository.insert({ ...NEW_TASK, taskId: "old-running", instanceId: "old" });
    await repository.insert({ ...NEW_TASK, taskId: "old-done", instanceId: "old" });
    await repository.settle("old-done", { status: "completed", result: { content: [] } });
    await repository.insert({ ...NEW_TASK, taskId: "mine", instanceId: "new" });

    const failed = await repository.failInterrupted(
      "new",
      { code: -32603, message: "interrupted" },
      "interrupted",
    );

    expect(failed).toBe(1);
    const row = await repository.find("old-running");
    expect(row?.status).toBe("failed");
    expect(row?.error).toEqual({ code: -32603, message: "interrupted" });
    expect(row?.expiresAtMs).toBe(10_000 + NEW_TASK.retentionMs);
    expect((await repository.find("old-done"))?.status).toBe("completed");
    expect((await repository.find("mine"))?.status).toBe("working");
  });

  test("deleteExpired removes only terminal rows past their expiry", async () => {
    await repository.insert({ ...NEW_TASK, taskId: "done", retentionMs: 100 });
    await repository.settle("done", { status: "completed", result: { content: [] } });
    await repository.insert({ ...NEW_TASK, taskId: "running" });

    timer.advanceTime(99);
    expect(await repository.deleteExpired()).toBe(0);
    timer.advanceTime(1);
    expect(await repository.deleteExpired()).toBe(1);

    expect(await repository.find("done")).toBeUndefined();
    expect(await repository.find("running")).toBeDefined();
  });

  test("an unreadable JSON column is reported as null with a warning", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await repository.insert(NEW_TASK);
      await db
        .updateTable("mcp_tasks")
        .set({ status: "completed", result_json: "not json" })
        .where("task_id", "=", "task-1")
        .execute();
      expect((await repository.find("task-1"))?.result).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("DefaultTaskManager over the SQLite repository (#4668)", () => {
  test("a restarted manager answers get and fails the task the previous instance left running", async () => {
    const db = await createTestDatabase();
    try {
      const timer = new FakeTimer();
      const store = new McpTaskRepository({ db, timer });
      const before = new DefaultTaskManager({
        store,
        timer,
        idGenerator: new CountingIdGenerator("a"),
        instanceId: "before",
      });
      const task = await before.create({ ownerKey: "k", toolName: "startDevice" });

      const after = new DefaultTaskManager({
        store,
        timer,
        idGenerator: new CountingIdGenerator("b"),
        instanceId: "after",
      });
      const record = await after.get("k", task.taskId);
      expect(record.status).toBe("failed");
      expect(record.error).toEqual({ code: -32603, message: TASK_INTERRUPTED_MESSAGE });
    } finally {
      await db.destroy();
    }
  });
});
