import { taskEligibleByName } from "../../../src/server/tasks/toolCallTasks";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import {
  DefaultTaskManager,
  TASK_INTERRUPTED_MESSAGE,
} from "../../../src/daemon/tasks/TaskManager";
import { SKILLS_EXTENSION_ID } from "@modelcontextprotocol/server/ext/skills";
import { TASKS_EXTENSION_ID } from "../../../src/daemon/tasks/mcpTasksExtension";
import type { TaskLeaseHoldRequest } from "../../../src/daemon/tasks/taskLeaseKeepalive";
import { currentTaskContext } from "../../../src/server/tasks/runAsTask";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { executionTracker } from "../../../src/daemon/executionTracker";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeMcpTaskStore } from "../../fakes/FakeMcpTaskStore";
import { FakeTaskManager } from "../../fakes/FakeTaskManager";
import { FakeTimer } from "../../fakes/FakeTimer";
import { installHermeticServerFixture } from "../../helpers/hermeticServerFixture";
import { connect } from "../../helpers/mcpTaskWire";

/*
 * MCP Tasks extension wire contract (#4668), asserted on the raw frames our server sends: a
 * client that declares `io.modelcontextprotocol/tasks` per request gets a task handle for an
 * eligible tool; one that does not gets exactly the synchronous result and never a task.
 */

const ECHO = "__task_echo__";
const WAIT = "__task_wait__";
const UNKNOWN = "__task_unregistered__";
const ELIGIBLE = taskEligibleByName(new Set([ECHO, WAIT, UNKNOWN]));

let releaseWait: (() => void) | undefined;
const leaseHolds: TaskLeaseHoldRequest[] = [];
const leaseReleases: string[] = [];

describe("Tasks extension over the wire (#4668)", () => {
  let restoreHermeticServer: () => void;
  let timer: FakeTimer;
  let store: FakeMcpTaskStore;
  let manager: FakeTaskManager;
  let keyA: Awaited<ReturnType<typeof connect>>;
  let keyB: Awaited<ReturnType<typeof connect>>;
  let keyless: Awaited<ReturnType<typeof connect>>;

  beforeAll(async () => {
    restoreHermeticServer = installHermeticServerFixture();
    ToolRegistry.register(ECHO, "echo", z.object({ text: z.string() }), {
      handler: async (args, progress) => {
        await progress?.(1, 2, "halfway");
        currentTaskContext()?.holdDeviceLease("session-1");
        return { content: [{ type: "text", text: `echo:${args.text}` }] };
      },
      supportsProgress: true,
    });
    ToolRegistry.register(WAIT, "wait", z.object({}), async (_args, _progress, signal) => {
      await new Promise<void>((resolve, reject) => {
        releaseWait = resolve;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return { content: [{ type: "text", text: "waited" }] };
    });
    timer = new FakeTimer();
    store = new FakeMcpTaskStore(timer);
    manager = new FakeTaskManager({ timer, store, instanceId: "instance-1" });
    const keepalive = {
      hold: (request: TaskLeaseHoldRequest) => {
        leaseHolds.push(request);
        return () => leaseReleases.push(request.taskId);
      },
    };
    const shared = {
      taskManager: manager,
      taskEligibleTools: ELIGIBLE,
      taskLeaseKeepalive: keepalive,
    };
    keyA = await connect({ ...shared, requestMcpSessionId: "key-a" });
    keyB = await connect({ ...shared, requestMcpSessionId: "key-b" });
    keyless = await connect(shared);
  });

  afterAll(async () => {
    await Promise.all([keyA?.close(), keyB?.close(), keyless?.close()]);
    restoreHermeticServer?.();
  });

  test("initialize advertises the extension only to a client that declared it", async () => {
    const params = (capabilities: Record<string, unknown>) => ({
      protocolVersion: "2025-11-25",
      capabilities,
      clientInfo: { name: "tasks-test", version: "1" },
    });
    const plain = await keyA.wire.request("initialize", params({}));
    const declaring = await keyA.wire.request(
      "initialize",
      params({ extensions: { [TASKS_EXTENSION_ID]: {} } }),
    );

    expect(JSON.stringify(plain.result.capabilities)).toBe(
      JSON.stringify({
        resources: { subscribe: true, listChanged: true },
        tools: { listChanged: true },
        prompts: {},
        extensions: { [SKILLS_EXTENSION_ID]: {} },
      }),
    );
    expect(declaring.result.capabilities.extensions).toEqual({
      [SKILLS_EXTENSION_ID]: {},
      [TASKS_EXTENSION_ID]: {},
    });
  });

  test("a non-declaring call gets the synchronous result and no task is created", async () => {
    const before = manager.calls.length;
    const frame = await keyA.wire.call(ECHO, { text: "sync" }, false);

    expect(frame.result).toEqual({ content: [{ type: "text", text: "echo:sync" }] });
    expect(manager.calls.length).toBe(before);
  });

  test("a declaring call gets a CreateTaskResult and tasks/get completes with the sync result", async () => {
    const created = await keyA.wire.call(ECHO, { text: "async" }, true);

    expect(created.result).toEqual({
      resultType: "task",
      taskId: expect.any(String),
      status: "working",
      createdAt: expect.any(String),
      lastUpdatedAt: expect.any(String),
      ttlMs: null,
      pollIntervalMs: 1_000,
    });
    expect(created.result.content).toBeUndefined();

    const done = await keyA.wire.settled(created.result.taskId);
    expect(done.result).toMatchObject({
      resultType: "complete",
      taskId: created.result.taskId,
      status: "completed",
      statusMessage: "halfway (1/2)",
      result: { content: [{ type: "text", text: "echo:async" }] },
    });
    expect(done.result.ttlMs).toBeGreaterThan(0);
    expect(leaseHolds).toContainEqual({
      taskId: created.result.taskId,
      ownerKey: "key-a",
      sessionUuid: "session-1",
    });
    expect(leaseReleases).toContain(created.result.taskId);
  });

  test("a keyless request runs synchronously even when it declares the extension", async () => {
    const frame = await keyless.wire.call(ECHO, { text: "keyless" }, true);
    expect(frame.result).toEqual({ content: [{ type: "text", text: "echo:keyless" }] });
  });

  test("tasks/* without the per-request declaration answer -32021", async () => {
    const created = await keyA.wire.call(ECHO, { text: "x" }, true);
    const frame = await keyA.wire.request("tasks/get", { taskId: created.result.taskId });

    expect(frame.error).toEqual({
      code: -32021,
      message: "Missing required client capability",
      data: { requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } } },
    });
  });

  test("another session key cannot see or cancel the task", async () => {
    const created = await keyA.wire.call(WAIT, {}, true);
    const taskId = created.result.taskId;

    for (const method of ["tasks/get", "tasks/cancel"] as const) {
      const frame = await keyB.wire.task(method, taskId);
      expect(frame.error).toEqual({
        code: -32602,
        message: "Failed to retrieve task: Task not found",
      });
    }
    releaseWait?.();
    expect((await keyA.wire.settled(taskId)).result.status).toBe("completed");
  });

  test("tasks/cancel acknowledges and cooperatively cancels the running tool", async () => {
    const created = await keyA.wire.call(WAIT, {}, true);
    const taskId = created.result.taskId;

    const ack = await keyA.wire.task("tasks/cancel", taskId);
    expect(ack.result).toEqual({ resultType: "complete" });

    const done = await keyA.wire.settled(taskId);
    expect(done.result.status).toBe("cancelled");
  });

  test("tasks/update on a working task is acknowledged and ignored", async () => {
    const created = await keyA.wire.call(ECHO, { text: "u" }, true);
    const ack = await keyA.wire.task("tasks/update", created.result.taskId, {
      inputResponses: { unknown: { action: "accept" } },
    });
    expect(ack.result).toEqual({ resultType: "complete" });
  });

  test("a protocol error during the call fails the task with that JSON-RPC error", async () => {
    const created = await keyA.wire.call(UNKNOWN, {}, true);
    const done = await keyA.wire.settled(created.result.taskId);

    expect(done.result.status).toBe("failed");
    expect(done.result.error.code).toBe(-32603);
    expect(typeof done.result.error.message).toBe("string");
  });

  test("an expired task answers -32602 'Task has expired'", async () => {
    const created = await keyA.wire.call(ECHO, { text: "e" }, true);
    await keyA.wire.settled(created.result.taskId);
    timer.advanceTime(10 * 60 * 1000);

    const frame = await keyA.wire.task("tasks/get", created.result.taskId);
    expect(frame.error).toEqual({
      code: -32602,
      message: "Failed to retrieve task: Task has expired",
    });
    timer.setCurrentTime(0);
  });

  test("a stateless request's close does not cancel the task it started", async () => {
    const shared = { taskManager: manager, taskEligibleTools: ELIGIBLE };
    // What the daemon endpoint does per POST: a one-off scope id, the explicit key header.
    const request = await connect({
      ...shared,
      stateless: true,
      requestMcpSessionId: "key-s",
      sessionContext: { sessionId: "scope-1" },
    });
    const created = await request.wire.call(WAIT, {}, true);
    // The endpoint's closeRequest: cancel the scope's executions, then close the server.
    expect(await executionTracker.cancelSessionExecutions("scope-1")).toBe(0);
    await request.close();

    releaseWait?.();
    const poll = await connect({ ...shared, stateless: true, requestMcpSessionId: "key-s" });
    try {
      const done = await poll.wire.settled(created.result.taskId);
      expect(done.result.status).toBe("completed");
      expect(done.result.result).toEqual({ content: [{ type: "text", text: "waited" }] });
    } finally {
      await poll.close();
    }
  });

  test("a restarted daemon answers tasks/get and reports the interrupted task as failed", async () => {
    const restartTimer = new FakeTimer();
    const sharedStore = new FakeMcpTaskStore(restartTimer);
    const before = new DefaultTaskManager({
      store: sharedStore,
      timer: restartTimer,
      idGenerator: new CountingIdGenerator("restart"),
      instanceId: "before",
    });
    const orphan = await before.create({ ownerKey: "key-r", toolName: WAIT });
    const after = new DefaultTaskManager({
      store: sharedStore,
      timer: restartTimer,
      idGenerator: new CountingIdGenerator("restart-2"),
      instanceId: "after",
    });
    const restarted = await connect({ requestMcpSessionId: "key-r", taskManager: after });
    try {
      const frame = await restarted.wire.task("tasks/get", orphan.taskId);
      expect(frame.result).toMatchObject({
        resultType: "complete",
        taskId: orphan.taskId,
        status: "failed",
        statusMessage: TASK_INTERRUPTED_MESSAGE,
        error: { code: -32603, message: TASK_INTERRUPTED_MESSAGE },
      });
    } finally {
      await restarted.close();
    }
  });
});
