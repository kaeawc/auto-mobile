import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { InProcessMcpDispatcher } from "../../src/daemon/inProcessMcpDispatcher";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { StatelessMcpRequestScope } from "../../src/daemon/statelessMcpHttpEndpoint";
import {
  createStatelessMcpServer,
  type StatelessMcpServerBase,
} from "../../src/daemon/statelessMcpServerFactory";
import type {
  JsonObject,
  McpTaskRecord,
  McpTaskRunningUpdate,
  McpTaskSettlement,
  McpTaskStore,
  NewMcpTask,
} from "../../src/db/mcpTaskRepository";
import { executionTracker } from "../../src/server/executionTracker";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { SessionToolBindingStore } from "../../src/server/sessionToolBindingStore";
import { TASKS_EXTENSION_ID } from "../../src/server/tasks/mcpTasksExtension";
import {
  DefaultTaskManager,
  TASK_INTERRUPTED_MESSAGE,
  type TaskManager,
} from "../../src/server/tasks/TaskManager";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeMcpTaskStore } from "../fakes/FakeMcpTaskStore";
import { FakeTimer } from "../fakes/FakeTimer";
import { fakeBindLock } from "../helpers/createTestUnixSocketServer";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";

/*
 * MCP Tasks through the stdio proxy (#4668), end to end on everything but the device boundary: a
 * raw stdio client, the real proxy server and `DaemonMcpProxy`, a real `DaemonClient` on a real
 * control socket, the daemon's `UnixSocketServer` and its in-process MCP dispatcher, and a real
 * task manager over an in-memory store.
 */

const ECHO = "__tasks_relay_echo__";
const WAIT = "__tasks_relay_wait__";
const ELIGIBLE = new Set([ECHO, WAIT]);
const DECLARED_META = {
  "io.modelcontextprotocol/clientCapabilities": { extensions: { [TASKS_EXTENSION_ID]: {} } },
};

type Frame = Record<string, any>;

class RawWire {
  private readonly waiters = new Map<string | number, (frame: Frame) => void>();
  private nextId = 1;

  constructor(private readonly transport: InMemoryTransport) {
    transport.onmessage = (frame) => {
      const id = "id" in frame ? frame.id : undefined;
      if (id !== undefined && ("result" in frame || "error" in frame)) {
        this.waiters.get(id)?.(frame as Frame);
      }
    };
  }

  async request(method: string, params?: Record<string, unknown>): Promise<Frame> {
    const id = this.nextId++;
    const answered = new Promise<Frame>((resolve) => this.waiters.set(id, resolve));
    await this.transport.send({
      jsonrpc: "2.0",
      id,
      method,
      ...(params && { params }),
    } as JSONRPCMessage);
    return answered;
  }

  call(name: string, args: Record<string, unknown>, declared: boolean): Promise<Frame> {
    return this.request("tools/call", {
      name,
      arguments: args,
      ...(declared && { _meta: DECLARED_META }),
    });
  }

  task(method: string, taskId: string): Promise<Frame> {
    return this.request(method, { taskId, _meta: DECLARED_META });
  }

  async settled(taskId: string): Promise<Frame> {
    for (let turn = 0; turn < 200; turn++) {
      const frame = await this.task("tasks/get", taskId);
      const status = frame.result?.status;
      if (frame.error || (status && status !== "working" && status !== "input_required")) {
        return frame;
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(`task ${taskId} never settled`);
  }
}

/**
 * The task store as one daemon process sees it. Once the process "dies" it writes nothing more,
 * as a killed daemon would not: here the stopped socket server's shutdown still aborts the tool
 * in process, and its settlement must not reach the store the restarted daemon reads.
 */
class ProcessTaskStore implements McpTaskStore {
  private alive = true;

  constructor(private readonly shared: McpTaskStore) {}

  die(): void {
    this.alive = false;
  }

  insert(task: NewMcpTask): Promise<McpTaskRecord> {
    return this.shared.insert(task);
  }

  find(taskId: string): Promise<McpTaskRecord | undefined> {
    return this.shared.find(taskId);
  }

  async updateRunning(taskId: string, update: McpTaskRunningUpdate): Promise<boolean> {
    return this.alive && (await this.shared.updateRunning(taskId, update));
  }

  async settle(taskId: string, settlement: McpTaskSettlement): Promise<boolean> {
    return this.alive && (await this.shared.settle(taskId, settlement));
  }

  failInterrupted(
    currentInstanceId: string,
    error: JsonObject,
    statusMessage: string,
  ): Promise<number> {
    return this.shared.failInterrupted(currentInstanceId, error, statusMessage);
  }

  deleteExpired(): Promise<number> {
    return this.shared.deleteExpired();
  }
}

function fakeDaemonState() {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({
      getSession: () => null,
      getDeviceLabels: () => undefined,
      releaseSession: async () => null,
    }),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
      resolveAutolockSessionForMcpSession: () => undefined,
    }),
  };
}

describe("MCP Tasks through the stdio proxy and the control socket (#4668)", () => {
  let restoreFixture: () => void;
  let releaseWait: (() => void) | undefined;
  let socketPath: string;
  let store: FakeMcpTaskStore;
  let scopes: StatelessMcpRequestScope[];
  let socketServer: UnixSocketServer | undefined;
  let closeProxy: (() => Promise<void>) | undefined;
  let isAvailableSpy: ReturnType<typeof spyOn> | undefined;

  beforeAll(() => {
    restoreFixture = installHermeticServerFixture();
    ToolRegistry.register(ECHO, "echo", z.object({ text: z.string() }), async (args) => ({
      content: [{ type: "text", text: `echo:${args.text}` }],
    }));
    ToolRegistry.register(WAIT, "wait", z.object({}), async (_args, _progress, signal) => {
      await new Promise<void>((resolve, reject) => {
        releaseWait = resolve;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return { content: [{ type: "text", text: "waited" }] };
    });
  });

  afterAll(() => {
    ToolRegistry.unregister(ECHO);
    ToolRegistry.unregister(WAIT);
    restoreFixture();
  });

  async function startDaemon(taskManager: TaskManager): Promise<void> {
    const bindings = new SessionToolBindingStore();
    // The daemon's per-forward server, with the task manager and eligible tools injected: the
    // daemon's real base carries neither, so they ride on the base the factory spreads.
    const base = {
      sessionToolBindingStore: bindings,
      taskManager,
      taskEligibleTools: ELIGIBLE,
    } as StatelessMcpServerBase;
    const dispatcher = new InProcessMcpDispatcher({
      idGenerator: new CountingIdGenerator(`scope-${randomUUID()}`),
      createServer: (context, scope) => {
        scopes.push(scope);
        return createStatelessMcpServer(base, context, scope);
      },
      cancelScopeExecutions: (scope, reason) =>
        executionTracker.cancelSessionExecutions(scope, reason),
      forgetScopeBindings: (scope) => bindings.forget(scope),
      closeReason: () => "mcp_forward_closed",
    });
    socketServer = new UnixSocketServer(
      socketPath,
      fakeDaemonState(),
      defaultTimer,
      null,
      { mcpDispatcher: dispatcher },
      new CountingIdGenerator(`socket-${randomUUID()}`),
      { bindLock: fakeBindLock },
    );
    await socketServer.start();
  }

  async function stopDaemon(): Promise<void> {
    await socketServer?.close();
    socketServer = undefined;
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
  }

  async function connectProxy(): Promise<RawWire> {
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        clientFactory: () => new DaemonClient(socketPath, 10_000, defaultTimer, {}, null),
        daemonManager,
        autoStartDaemon: false,
      },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await clientTransport.start();
    closeProxy = async () => {
      await server.close();
      await proxy.close();
    };
    return new RawWire(clientTransport);
  }

  function manager(instanceId: string, processStore: McpTaskStore = store): TaskManager {
    return new DefaultTaskManager({
      store: processStore,
      timer: new FakeTimer(),
      idGenerator: new CountingIdGenerator(`${instanceId}-task`),
      instanceId,
    });
  }

  beforeEach(() => {
    socketPath = join(tmpdir(), `mcp-tasks-${randomUUID().slice(0, 8)}.sock`);
    store = new FakeMcpTaskStore(new FakeTimer());
    scopes = [];
  });

  afterEach(async () => {
    releaseWait?.();
    releaseWait = undefined;
    await closeProxy?.();
    closeProxy = undefined;
    isAvailableSpy?.mockRestore();
    await stopDaemon();
  });

  test("a declaring client gets a task handle and polls it to the tool's result", async () => {
    await startDaemon(manager("daemon"));
    const wire = await connectProxy();

    const created = await wire.call(ECHO, { text: "async" }, true);

    expect(created.result).toEqual({
      resultType: "task",
      taskId: expect.any(String),
      status: "working",
      createdAt: expect.any(String),
      lastUpdatedAt: expect.any(String),
      ttlMs: null,
      pollIntervalMs: 1_000,
    });
    expect(Object.keys(created.result)[0]).toBe("resultType");
    const done = await wire.settled(created.result.taskId);
    expect(done.result).toMatchObject({
      resultType: "complete",
      taskId: created.result.taskId,
      status: "completed",
      result: { content: [{ type: "text", text: "echo:async" }] },
    });
    // The task is owned by the proxy, not by the socket session the call happened to use.
    const owners = scopes.map((scope) => scope.taskOwnerKey).filter((key) => key !== undefined);
    expect(new Set(owners).size).toBe(1);
    expect(owners[0]).toStartWith("proxy-tasks:");
  });

  test("a non-declaring client gets the synchronous result and no task", async () => {
    await startDaemon(manager("daemon"));
    const wire = await connectProxy();

    const frame = await wire.call(ECHO, { text: "sync" }, false);

    expect(frame.result).toEqual({ content: [{ type: "text", text: "echo:sync" }] });
    expect(scopes.some((scope) => scope.taskOwnerKey !== undefined)).toBe(false);
  });

  test("tasks/cancel through the proxy cancels the running tool", async () => {
    await startDaemon(manager("daemon"));
    const wire = await connectProxy();
    const created = await wire.call(WAIT, {}, true);

    const ack = await wire.task("tasks/cancel", created.result.taskId);

    expect(ack.result).toEqual({ resultType: "complete" });
    expect((await wire.settled(created.result.taskId)).result.status).toBe("cancelled");
  });

  test("the daemon's error for an unknown task reaches the client unchanged", async () => {
    await startDaemon(manager("daemon"));
    const wire = await connectProxy();

    const frame = await wire.task("tasks/get", "no-such-task");

    expect(frame.error).toEqual({
      code: -32602,
      message: "Failed to retrieve task: Task not found",
    });
  });

  test("after a daemon restart mid-task the proxy reconnects and reports the task interrupted", async () => {
    const beforeStore = new ProcessTaskStore(store);
    await startDaemon(manager("before", beforeStore));
    const wire = await connectProxy();
    const created = await wire.call(WAIT, {}, true);
    expect(created.result.status).toBe("working");

    beforeStore.die();
    await stopDaemon();
    await startDaemon(manager("after"));
    const frame = await wire.task("tasks/get", created.result.taskId);

    expect(frame.result).toMatchObject({
      resultType: "complete",
      taskId: created.result.taskId,
      status: "failed",
      statusMessage: TASK_INTERRUPTED_MESSAGE,
      error: { code: -32603, message: TASK_INTERRUPTED_MESSAGE },
    });
  });
});
