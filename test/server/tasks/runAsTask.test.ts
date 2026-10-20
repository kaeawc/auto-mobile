import { describe, expect, spyOn, test } from "bun:test";
import { logger } from "../../../src/utils/logger";
import {
  currentTaskContext,
  holdTaskDeviceLeases,
  runAsTask,
  toJsonRpcError,
} from "../../../src/server/tasks/runAsTask";
import type { TaskLeaseHoldRequest } from "../../../src/daemon/tasks/taskLeaseKeepalive";
import { McpError } from "../../../src/daemon/mcpError";
import { FakeTaskManager } from "../../fakes/FakeTaskManager";

const OK = { content: [{ type: "text" as const, text: "ok" }] };

type RunAsTaskResult = Awaited<ReturnType<typeof runAsTask>>;

/** The task id of a task handle; empty for a synchronous tool result. */
function taskIdOf(handle: RunAsTaskResult): string {
  return typeof handle.taskId === "string" ? handle.taskId : "";
}

async function settled(manager: FakeTaskManager, taskId: string) {
  for (let turn = 0; turn < 50; turn++) {
    const record = await manager.get("k", taskId);
    if (record.status !== "working" && record.status !== "input_required") {
      return record;
    }
    await Promise.resolve();
  }
  throw new Error("never settled");
}

describe("runAsTask (#4668)", () => {
  test("runs synchronously, with nothing overridden, when the request did not declare tasks", async () => {
    const manager = new FakeTaskManager();
    const runs: unknown[] = [];
    const result = await runAsTask(
      { declared: false, ownerKey: "k", taskManager: manager, toolName: "t" },
      async (run) => {
        runs.push(run);
        return OK;
      },
    );
    expect(result).toEqual(OK);
    expect(runs).toEqual([{}]);
    expect(manager.calls).toEqual([]);
  });

  test("runs synchronously without a session key or a task manager", async () => {
    const manager = new FakeTaskManager();
    for (const options of [
      { declared: true, ownerKey: undefined, taskManager: manager, toolName: "t" },
      { declared: true, ownerKey: "k", taskManager: undefined, toolName: "t" },
    ]) {
      expect(await runAsTask(options, async () => OK)).toEqual(OK);
    }
    expect(manager.calls).toEqual([]);
  });

  test("returns a task handle and runs the work under the task's context", async () => {
    const manager = new FakeTaskManager();
    let seenTaskId: string | undefined;
    const handle = await runAsTask(
      { declared: true, ownerKey: "k", taskManager: manager, toolName: "t" },
      async (run) => {
        seenTaskId = currentTaskContext()?.taskId;
        expect(run.signal).toBe(manager.created[0]?.signal);
        await run.progress?.(3, undefined, undefined);
        return OK;
      },
    );
    expect(handle).toMatchObject({ resultType: "task", status: "working" });
    const taskId = taskIdOf(handle);
    const record = await settled(manager, taskId);
    expect(seenTaskId).toBe(taskId);
    expect(record.status).toBe("completed");
    expect(record.result).toEqual(OK);
    expect(record.statusMessage).toBe("Progress 3");
  });

  test("holds each named session once per task and releases it when the task settles", async () => {
    const manager = new FakeTaskManager();
    const holds: TaskLeaseHoldRequest[] = [];
    const released: string[] = [];
    const keepalive = {
      hold(request: TaskLeaseHoldRequest) {
        holds.push(request);
        return () => released.push(request.sessionUuid);
      },
    };
    // Outside a task nothing is held.
    holdTaskDeviceLeases(["outside"]);
    const handle = await runAsTask(
      { declared: true, ownerKey: "k", taskManager: manager, toolName: "t", keepalive },
      async () => {
        holdTaskDeviceLeases(["base", undefined, "", "base"]);
        holdTaskDeviceLeases(["base", "base:B"]);
        currentTaskContext()?.holdDeviceLease("base:B");
        return OK;
      },
    );
    const taskId = taskIdOf(handle);
    await settled(manager, taskId);
    expect(holds).toEqual([
      { taskId, ownerKey: "k", sessionUuid: "base" },
      { taskId, ownerKey: "k", sessionUuid: "base:B" },
    ]);
    expect(released).toEqual(["base", "base:B"]);
  });

  test("an isError result after tasks/cancel settles as cancelled", async () => {
    const manager = new FakeTaskManager();
    const handle = await runAsTask(
      { declared: true, ownerKey: "k", taskManager: manager, toolName: "t" },
      (run) =>
        new Promise((resolve) => {
          run.signal?.addEventListener("abort", () =>
            resolve({ isError: true, content: [{ type: "text", text: "aborted" }] }),
          );
        }),
    );
    const taskId = taskIdOf(handle);
    await manager.cancel("k", taskId);
    expect((await settled(manager, taskId)).status).toBe("cancelled");
  });

  test("detach cancels polling promptly but preserves the work signal, context and lease until completion", async () => {
    const manager = new FakeTaskManager();
    const gate = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const released: string[] = [];
    let signal: AbortSignal | undefined;
    let contextSignal: AbortSignal | undefined;
    const handle = await runAsTask(
      {
        declared: true,
        ownerKey: "k",
        taskManager: manager,
        toolName: "videoRecording",
        onCancel: "detach",
        keepalive: {
          hold: () => () => {
            released.push("lease");
            ended.resolve();
          },
        },
      },
      async (run) => {
        signal = run.signal;
        contextSignal = currentTaskContext()?.signal;
        holdTaskDeviceLeases(["device"]);
        await gate.promise;
        return OK;
      },
    );
    const taskId = taskIdOf(handle);
    try {
      await manager.cancel("k", taskId);
      const cancelled = await manager.get("k", taskId);
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.statusMessage).toContain("continues");
      expect(signal).toBeDefined();
      expect(signal?.aborted).toBe(false);
      expect(contextSignal).toBe(signal);
      expect(released).toEqual([]);
    } finally {
      gate.resolve();
      await ended.promise;
    }
    const final = await manager.get("k", taskId);
    expect(final.status).toBe("cancelled");
    expect(final.result).toBeNull();
    expect(released).toEqual(["lease"]);
  });

  test.each(["throw", "isError"])(
    "detach logs a post-cancel %s and leaves the task cancelled",
    async (failure) => {
      const manager = new FakeTaskManager();
      const gate = Promise.withResolvers<void>();
      const ended = Promise.withResolvers<void>();
      const warning = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const handle = await runAsTask(
          {
            declared: true,
            ownerKey: "k",
            taskManager: manager,
            toolName: "videoRecording",
            onCancel: "detach",
            keepalive: { hold: () => () => ended.resolve() },
          },
          async () => {
            holdTaskDeviceLeases(["device"]);
            await gate.promise;
            if (failure === "throw") {
              throw new Error("finalization failed");
            }
            return { ...OK, isError: true };
          },
        );
        const taskId = taskIdOf(handle);
        await manager.cancel("k", taskId);
        expect((await manager.get("k", taskId)).status).toBe("cancelled");
        gate.resolve();
        await ended.promise;
        expect((await manager.get("k", taskId)).status).toBe("cancelled");
        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining("after cancellation"),
          expect.anything(),
        );
      } finally {
        gate.resolve();
        await ended.promise;
        warning.mockRestore();
      }
    },
  );

  test("abort policy aborts the work signal but waits for the work to unwind", async () => {
    const manager = new FakeTaskManager();
    const gate = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const handle = await runAsTask(
      {
        declared: true,
        ownerKey: "k",
        taskManager: manager,
        toolName: "installApp",
        onCancel: "abort",
      },
      async (run) => {
        signal = run.signal;
        await gate.promise;
        run.signal?.throwIfAborted();
        return OK;
      },
    );
    const taskId = taskIdOf(handle);
    try {
      await manager.cancel("k", taskId);
      expect(signal?.aborted).toBe(true);
      expect((await manager.get("k", taskId)).status).toBe("working");
    } finally {
      gate.resolve();
    }
    expect((await settled(manager, taskId)).status).toBe("cancelled");
  });

  test("toJsonRpcError keeps a protocol error's code and data, else -32603", () => {
    expect(toJsonRpcError(new McpError(-32602, "bad", { x: 1 }))).toEqual({
      code: -32602,
      message: "MCP error -32602: bad",
      data: { x: 1 },
    });
    expect(toJsonRpcError(new Error("boom"))).toEqual({ code: -32603, message: "boom" });
    expect(toJsonRpcError("nope")).toEqual({ code: -32603, message: "Internal error" });
  });

  test("a completion the store rejects still leaves the task terminal through the fallback fail (#13143)", async () => {
    const manager = new FakeTaskManager();
    manager.store.settleFailures = 1;
    const handle = await runAsTask(
      { declared: true, ownerKey: "k", taskManager: manager, toolName: "t" },
      async () => OK,
    );
    const record = await settled(manager, taskIdOf(handle));
    expect(record.status).toBe("failed");
    expect(String(record.error?.message)).toContain("SQLITE_BUSY");
  });
});
