import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TASK_POLL_INTERVAL_MS,
  DEFAULT_TASK_RETENTION_MS,
  DefaultTaskManager,
  TASK_INTERRUPTED_MESSAGE,
} from "../../../src/daemon/tasks/TaskManager";
import { toCreateTaskResult, toGetTaskResult } from "../../../src/daemon/tasks/mcpTasksExtension";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeMcpTaskStore } from "../../fakes/FakeMcpTaskStore";
import { FakeTimer } from "../../fakes/FakeTimer";

function setup(options: { instanceId?: string; store?: FakeMcpTaskStore; timer?: FakeTimer } = {}) {
  const timer = options.timer ?? new FakeTimer();
  const store = options.store ?? new FakeMcpTaskStore(timer);
  const manager = new DefaultTaskManager({
    store,
    timer,
    idGenerator: new CountingIdGenerator(options.instanceId ?? "task"),
    instanceId: options.instanceId ?? "instance-1",
  });
  return { timer, store, manager };
}

async function rejection(promise: Promise<unknown>): Promise<{ code?: number; message?: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: number; message?: string };
  }
  throw new Error("expected a rejection");
}

describe("DefaultTaskManager (#4668)", () => {
  test("creates a durable working task with the default poll interval and no ttl while running", async () => {
    const { manager, timer } = setup();
    timer.setCurrentTime(1_000);

    const task = await manager.create({ ownerKey: "key-a", toolName: "startDevice" });

    expect(task.taskId).toBe("task-1");
    expect(toCreateTaskResult(task.created)).toEqual({
      resultType: "task",
      taskId: "task-1",
      status: "working",
      createdAt: new Date(1_000).toISOString(),
      lastUpdatedAt: new Date(1_000).toISOString(),
      ttlMs: null,
      pollIntervalMs: DEFAULT_TASK_POLL_INTERVAL_MS,
    });
    expect((await manager.get("key-a", "task-1")).status).toBe("working");
  });

  test("a per-task poll interval overrides the default", async () => {
    const { manager } = setup();
    const task = await manager.create({ ownerKey: "k", toolName: "t", pollIntervalMs: 2_500 });
    expect(task.created.pollIntervalMs).toBe(2_500);
  });

  test("completion inlines the result and starts the retention window", async () => {
    const { manager, timer } = setup();
    const task = await manager.create({ ownerKey: "k", toolName: "t" });
    timer.advanceTime(4_000);

    await task.complete({ content: [{ type: "text", text: "done" }] });

    const got = toGetTaskResult(await manager.get("k", task.taskId));
    expect(got.status).toBe("completed");
    expect(got.result).toEqual({ content: [{ type: "text", text: "done" }] });
    expect(got.ttlMs).toBe(4_000 + DEFAULT_TASK_RETENTION_MS);
  });

  test("a finished task expires after the retention window, then is purged", async () => {
    const { manager, timer, store } = setup();
    const task = await manager.create({ ownerKey: "k", toolName: "t" });
    await task.complete({ content: [] });

    timer.advanceTime(DEFAULT_TASK_RETENTION_MS - 1);
    expect((await manager.get("k", task.taskId)).status).toBe("completed");

    timer.advanceTime(1);
    const expired = await rejection(manager.get("k", task.taskId));
    expect(expired.code).toBe(-32602);
    expect(expired.message).toBe("Failed to retrieve task: Task has expired");

    await manager.create({ ownerKey: "k", toolName: "t" });
    expect(store.rows.has(task.taskId)).toBe(false);
    expect((await rejection(manager.get("k", task.taskId))).message).toBe(
      "Failed to retrieve task: Task not found",
    );
  });

  test("another session key cannot read, update or cancel the task", async () => {
    const { manager } = setup();
    const task = await manager.create({ ownerKey: "key-a", toolName: "t" });

    for (const call of [
      manager.get("key-b", task.taskId),
      manager.update("key-b", task.taskId, {}),
      manager.cancel("key-b", task.taskId),
    ]) {
      const error = await rejection(call);
      expect(error.code).toBe(-32602);
      expect(error.message).toBe("Failed to retrieve task: Task not found");
    }
    expect(task.signal.aborted).toBe(false);
  });

  test("failure carries the JSON-RPC error and a terminal task never changes again", async () => {
    const { manager } = setup();
    const task = await manager.create({ ownerKey: "k", toolName: "t" });

    await task.fail({ code: -32603, message: "boom" }, "Tool execution failed: boom");
    await task.complete({ content: [] });
    await manager.cancel("k", task.taskId);

    const got = toGetTaskResult(await manager.get("k", task.taskId));
    expect(got.status).toBe("failed");
    expect(got.error).toEqual({ code: -32603, message: "boom" });
    expect(got.statusMessage).toBe("Tool execution failed: boom");
  });

  test("cancel aborts the task's signal; the work then settles it as cancelled", async () => {
    const { manager } = setup();
    const task = await manager.create({ ownerKey: "k", toolName: "t" });

    await manager.cancel("k", task.taskId);
    expect(task.signal.aborted).toBe(true);
    expect(task.cancelRequested).toBe(true);
    // Eventually consistent: still working until the work unwinds.
    expect((await manager.get("k", task.taskId)).status).toBe("working");

    await task.markCancelled();
    expect((await manager.get("k", task.taskId)).status).toBe("cancelled");
  });

  test("input_required round trip: partial responses keep waiting, unknown keys are ignored", async () => {
    const { manager } = setup();
    const task = await manager.create({ ownerKey: "k", toolName: "t" });

    const answered = task.requestInput({
      a: { method: "elicitation/create", params: { message: "A?" } },
      b: { method: "elicitation/create", params: { message: "B?" } },
    });
    await Promise.resolve();
    let got = toGetTaskResult(await manager.get("k", task.taskId));
    expect(got.status).toBe("input_required");
    expect(Object.keys(got.inputRequests ?? {})).toEqual(["a", "b"]);

    await manager.update("k", task.taskId, { a: { action: "accept" }, zzz: { action: "accept" } });
    got = toGetTaskResult(await manager.get("k", task.taskId));
    expect(got.status).toBe("input_required");
    expect(Object.keys(got.inputRequests ?? {})).toEqual(["b"]);

    await manager.update("k", task.taskId, { b: { action: "decline" } });
    expect(await answered).toEqual({ a: { action: "accept" }, b: { action: "decline" } });
    got = toGetTaskResult(await manager.get("k", task.taskId));
    expect(got.status).toBe("working");
    expect(got.inputRequests).toBeUndefined();
  });

  test("cancel while waiting for input rejects the wait", async () => {
    const { manager } = setup();
    const task = await manager.create({ ownerKey: "k", toolName: "t" });
    const answered = task.requestInput({ a: { method: "elicitation/create", params: {} } });
    await Promise.resolve();

    await manager.cancel("k", task.taskId);

    expect((await rejection(answered)) instanceof DOMException).toBe(true);
  });

  test("status messages update a running task", async () => {
    const { manager } = setup();
    const task = await manager.create({ ownerKey: "k", toolName: "t" });
    await task.setStatusMessage("Booting (1/3)");
    expect((await manager.get("k", task.taskId)).statusMessage).toBe("Booting (1/3)");
  });

  test("restart: a new instance fails tasks the previous one left running and still answers get", async () => {
    const timer = new FakeTimer();
    const store = new FakeMcpTaskStore(timer);
    const before = setup({ timer, store, instanceId: "old" }).manager;
    const running = await before.create({ ownerKey: "k", toolName: "startDevice" });
    const finished = await before.create({ ownerKey: "k", toolName: "startDevice" });
    await finished.complete({ content: [{ type: "text", text: "ok" }] });

    const after = setup({ timer, store, instanceId: "new" }).manager;

    const failed = toGetTaskResult(await after.get("k", running.taskId));
    expect(failed.status).toBe("failed");
    expect(failed.statusMessage).toBe(TASK_INTERRUPTED_MESSAGE);
    expect(failed.error).toEqual({ code: -32603, message: TASK_INTERRUPTED_MESSAGE });
    expect((await after.get("k", finished.taskId)).status).toBe("completed");
    // The stale handle can no longer change the row.
    await running.complete({ content: [] });
    expect((await after.get("k", running.taskId)).status).toBe("failed");
  });
});

describe("DefaultTaskManager persistence failures and input keys (#13143)", () => {
  test("a settle the store rejects leaves the task settleable, so the fallback fail persists", async () => {
    const { manager, store } = setup();
    const task = await manager.create({ ownerKey: "k", toolName: "t" });
    store.settleFailures = 1;

    expect((await rejection(task.complete({ content: [] }))).message).toContain("SQLITE_BUSY");
    expect((await manager.get("k", task.taskId)).status).toBe("working");

    await task.fail({ code: -32603, message: "store busy" });
    const got = await manager.get("k", task.taskId);
    expect(got.status).toBe("failed");
    expect(got.error).toEqual({ code: -32603, message: "store busy" });
  });

  test("a final input response the store rejects keeps the waiter, so a retry resolves it", async () => {
    const { manager, store } = setup();
    const task = await manager.create({ ownerKey: "k", toolName: "t" });
    const answered = task.requestInput({ a: { method: "elicitation/create", params: {} } });
    await Promise.resolve();
    store.updateRunningFailures = 1;

    expect(
      (await rejection(manager.update("k", task.taskId, { a: { action: "accept" } }))).message,
    ).toContain("SQLITE_BUSY");
    expect((await manager.get("k", task.taskId)).status).toBe("input_required");

    await manager.update("k", task.taskId, { a: { action: "accept" } });
    expect(await answered).toEqual({ a: { action: "accept" } });
    expect((await manager.get("k", task.taskId)).status).toBe("working");
  });

  test("an input request the store rejects clears the waiter, so the work can ask again", async () => {
    const { manager, store } = setup();
    const task = await manager.create({ ownerKey: "k", toolName: "t" });
    store.updateRunningFailures = 1;

    expect(
      (await rejection(task.requestInput({ a: { method: "elicitation/create", params: {} } })))
        .message,
    ).toContain("SQLITE_BUSY");

    const answered = task.requestInput({ a: { method: "elicitation/create", params: {} } });
    await Promise.resolve();
    expect((await manager.get("k", task.taskId)).status).toBe("input_required");
    await manager.update("k", task.taskId, { a: { action: "decline" } });
    expect(await answered).toEqual({ a: { action: "decline" } });
  });

  test("input-request keys stay unique over the task's whole life", async () => {
    const { manager } = setup();
    const task = await manager.create({ ownerKey: "k", toolName: "t" });
    const first = task.requestInput({ a: { method: "elicitation/create", params: {} } });
    await Promise.resolve();
    await manager.update("k", task.taskId, { a: { action: "accept" } });
    await first;

    const reused = await rejection(
      task.requestInput({
        b: { method: "elicitation/create", params: {} },
        a: { method: "elicitation/create", params: {} },
      }),
    );
    expect(reused.message).toContain('"a"');
    expect((await manager.get("k", task.taskId)).status).toBe("working");

    const second = task.requestInput({ b: { method: "elicitation/create", params: {} } });
    await Promise.resolve();
    await manager.update("k", task.taskId, { b: { action: "accept" } });
    expect(await second).toEqual({ b: { action: "accept" } });
  });
});
