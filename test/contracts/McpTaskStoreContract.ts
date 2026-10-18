import { describe, expect, test } from "bun:test";
import type { McpTaskStore, NewMcpTask } from "../../src/db/mcpTaskRepository";
import { FakeTimer } from "../fakes/FakeTimer";

export interface McpTaskStoreHandle {
  store: McpTaskStore;
  dispose?: () => Promise<void>;
}

const START_MS = 10_000;

function newTask(overrides: Partial<NewMcpTask> = {}): NewMcpTask {
  return {
    taskId: "task-1",
    ownerKey: "key-a",
    toolName: "startDevice",
    instanceId: "instance-1",
    pollIntervalMs: 1_000,
    retentionMs: 600_000,
    ...overrides,
  };
}

/**
 * Shared behavioural contract for {@link McpTaskStore} (#11868): run it against the in-memory
 * fake and the SQLite repository over an in-memory database. Both stores stamp rows from the
 * FakeTimer the factory is handed, so the contract controls the clock.
 */
export function runMcpTaskStoreContract(
  name: string,
  make: (timer: FakeTimer) => Promise<McpTaskStoreHandle>,
): void {
  const withStore = async (
    body: (store: McpTaskStore, timer: FakeTimer) => Promise<void>,
  ): Promise<void> => {
    const timer = new FakeTimer();
    timer.setCurrentTime(START_MS);
    const handle = await make(timer);
    try {
      await body(handle.store, timer);
    } finally {
      await handle.dispose?.();
    }
  };

  describe(`McpTaskStore contract: ${name}`, () => {
    test("insert creates a working task stamped by the clock, and find reads it back", () =>
      withStore(async (store) => {
        const created = await store.insert(newTask({ statusMessage: "Starting" }));

        expect(created).toEqual({
          ...newTask(),
          status: "working",
          statusMessage: "Starting",
          createdAtMs: START_MS,
          lastUpdatedAtMs: START_MS,
          terminalAtMs: null,
          expiresAtMs: null,
          inputRequests: null,
          result: null,
          error: null,
        });
        expect(await store.find("task-1")).toEqual(created);
        expect(await store.find("missing")).toBeUndefined();
      }));

    test("a task inserted without a status message has none", () =>
      withStore(async (store) => {
        expect((await store.insert(newTask())).statusMessage).toBeNull();
      }));

    test("inserting an existing task id is rejected and leaves the first task intact", () =>
      withStore(async (store) => {
        await store.insert(newTask({ toolName: "first" }));

        await expect(store.insert(newTask({ toolName: "second" }))).rejects.toThrow();
        expect((await store.find("task-1"))?.toolName).toBe("first");
      }));

    test("updateRunning moves between running statuses and keeps fields it was not given", () =>
      withStore(async (store, timer) => {
        await store.insert(newTask({ statusMessage: "Starting" }));
        timer.advanceTime(5);

        expect(
          await store.updateRunning("task-1", {
            status: "input_required",
            inputRequests: { prompt: { method: "elicitation/create" } },
          }),
        ).toBe(true);
        expect(await store.find("task-1")).toMatchObject({
          status: "input_required",
          statusMessage: "Starting",
          inputRequests: { prompt: { method: "elicitation/create" } },
          createdAtMs: START_MS,
          lastUpdatedAtMs: START_MS + 5,
          terminalAtMs: null,
          expiresAtMs: null,
        });
      }));

    test("updateRunning clears the message and input requests when given null", () =>
      withStore(async (store) => {
        await store.insert(newTask({ statusMessage: "Starting" }));
        await store.updateRunning("task-1", {
          status: "input_required",
          inputRequests: { a: 1 },
        });

        expect(
          await store.updateRunning("task-1", {
            status: "working",
            statusMessage: null,
            inputRequests: null,
          }),
        ).toBe(true);
        expect(await store.find("task-1")).toMatchObject({
          status: "working",
          statusMessage: null,
          inputRequests: null,
        });
      }));

    test("updateRunning reports false for a missing task", () =>
      withStore(async (store) => {
        expect(await store.updateRunning("missing", { status: "working" })).toBe(false);
      }));

    test("settle completed stores the result, stamps terminal and expiry, drops input requests", () =>
      withStore(async (store, timer) => {
        await store.insert(newTask());
        await store.updateRunning("task-1", { status: "input_required", inputRequests: { a: 1 } });
        timer.advanceTime(50);

        expect(
          await store.settle("task-1", {
            status: "completed",
            result: { ok: true },
            statusMessage: "Done",
          }),
        ).toBe(true);
        expect(await store.find("task-1")).toMatchObject({
          status: "completed",
          statusMessage: "Done",
          result: { ok: true },
          error: null,
          inputRequests: null,
          lastUpdatedAtMs: START_MS + 50,
          terminalAtMs: START_MS + 50,
          expiresAtMs: START_MS + 50 + 600_000,
        });
      }));

    test("settle failed stores the error and no result", () =>
      withStore(async (store) => {
        await store.insert(newTask());

        expect(await store.settle("task-1", { status: "failed", error: { code: -1 } })).toBe(true);
        expect(await store.find("task-1")).toMatchObject({
          status: "failed",
          error: { code: -1 },
          result: null,
          statusMessage: null,
        });
      }));

    test("settle cancelled keeps the stored message when none is given", () =>
      withStore(async (store) => {
        await store.insert(newTask({ statusMessage: "Starting" }));

        expect(await store.settle("task-1", { status: "cancelled" })).toBe(true);
        expect(await store.find("task-1")).toMatchObject({
          status: "cancelled",
          statusMessage: "Starting",
          result: null,
          error: null,
        });
      }));

    test("a terminal task is fenced: no further update or settle changes it", () =>
      withStore(async (store, timer) => {
        await store.insert(newTask());
        await store.settle("task-1", { status: "completed", result: { first: true } });
        const settled = await store.find("task-1");
        timer.advanceTime(10);

        expect(await store.updateRunning("task-1", { status: "working" })).toBe(false);
        expect(await store.settle("task-1", { status: "cancelled" })).toBe(false);
        expect(await store.find("task-1")).toEqual(settled);
      }));

    test("settle reports false for a missing task", () =>
      withStore(async (store) => {
        expect(await store.settle("missing", { status: "cancelled" })).toBe(false);
      }));

    test("failInterrupted fails only running tasks left by another instance", () =>
      withStore(async (store, timer) => {
        await store.insert(newTask({ taskId: "stale-working", instanceId: "old" }));
        await store.insert(newTask({ taskId: "stale-input", instanceId: "old" }));
        await store.updateRunning("stale-input", { status: "input_required", inputRequests: {} });
        await store.insert(newTask({ taskId: "stale-done", instanceId: "old" }));
        await store.settle("stale-done", { status: "completed", result: {} });
        await store.insert(newTask({ taskId: "current", instanceId: "now" }));
        timer.advanceTime(20);

        expect(await store.failInterrupted("now", { reason: "restart" }, "Interrupted")).toBe(2);

        for (const taskId of ["stale-working", "stale-input"]) {
          expect(await store.find(taskId)).toMatchObject({
            status: "failed",
            statusMessage: "Interrupted",
            error: { reason: "restart" },
            inputRequests: null,
            terminalAtMs: START_MS + 20,
            expiresAtMs: START_MS + 20 + 600_000,
          });
        }
        expect((await store.find("stale-done"))?.status).toBe("completed");
        expect((await store.find("current"))?.status).toBe("working");
        expect(await store.failInterrupted("now", {}, "again")).toBe(0);
      }));

    test("deleteExpired removes only terminal tasks whose retention has elapsed", () =>
      withStore(async (store, timer) => {
        await store.insert(newTask({ taskId: "short", retentionMs: 100 }));
        await store.insert(newTask({ taskId: "long", retentionMs: 1_000 }));
        await store.insert(newTask({ taskId: "running", retentionMs: 1 }));
        await store.settle("short", { status: "cancelled" });
        await store.settle("long", { status: "cancelled" });

        timer.advanceTime(99);
        expect(await store.deleteExpired()).toBe(0);

        timer.advanceTime(1);
        expect(await store.deleteExpired()).toBe(1);
        expect(await store.find("short")).toBeUndefined();
        expect(await store.find("long")).toBeDefined();

        timer.advanceTime(10_000);
        expect(await store.deleteExpired()).toBe(1);
        expect(await store.find("running")).toBeDefined();
      }));
  });
}
