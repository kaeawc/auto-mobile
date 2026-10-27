import { beforeEach, afterEach, describe, expect, spyOn, test } from "bun:test";
import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { DaemonClient, DaemonUnavailableError } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/wire/constants";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { TASKS_EXTENSION_ID } from "../../src/daemon/tasks/mcpTasksExtension";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";

/*
 * The stdio proxy relays the MCP Tasks extension (#4668) to the daemon: a client that declares
 * `io.modelcontextprotocol/tasks` reaches the daemon's tasks through it, and one that does not
 * sees exactly the synchronous proxy it always did. Asserted on the raw frames the proxy sends.
 */

const DECLARED_META = {
  "io.modelcontextprotocol/clientCapabilities": { extensions: { [TASKS_EXTENSION_ID]: {} } },
};

const CREATED = {
  resultType: "task",
  taskId: "task-1",
  status: "working",
  createdAt: "2026-10-18T00:00:00.000Z",
  lastUpdatedAt: "2026-10-18T00:00:00.000Z",
  ttlMs: null,
  pollIntervalMs: 1_000,
};

const COMPLETED = {
  resultType: "complete",
  taskId: "task-1",
  status: "completed",
  createdAt: "2026-10-18T00:00:00.000Z",
  lastUpdatedAt: "2026-10-18T00:00:01.000Z",
  ttlMs: 601_000,
  pollIntervalMs: 1_000,
  result: { content: [{ type: "text", text: "done" }] },
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

  call(name: string, declared: boolean): Promise<Frame> {
    return this.request("tools/call", {
      name,
      arguments: {},
      ...(declared && { _meta: DECLARED_META }),
    });
  }

  task(method: string, params: Record<string, unknown>, declared = true): Promise<Frame> {
    return this.request(method, { ...params, ...(declared && { _meta: DECLARED_META }) });
  }
}

describe("stdio proxy relays the Tasks extension to the daemon (#4668)", () => {
  let isAvailableSpy: ReturnType<typeof spyOn>;
  let closeProxy: (() => Promise<void>) | undefined;

  beforeEach(() => {
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
  });

  afterEach(async () => {
    try {
      await closeProxy?.();
    } finally {
      closeProxy = undefined;
      isAvailableSpy.mockRestore();
    }
  });

  async function connect(...clients: FakeDaemonClient[]): Promise<RawWire> {
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    let next = 0;
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        clientFactory: () => clients[Math.min(next++, clients.length - 1)],
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

  function daemon(options: ConstructorParameters<typeof FakeDaemonClient>[0] = {}) {
    return new FakeDaemonClient({
      daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
      ...options,
    });
  }

  test("initialize advertises the extension only to a client that declared it", async () => {
    const wire = await connect(daemon());
    const params = (capabilities: Record<string, unknown>) => ({
      protocolVersion: "2025-11-25",
      capabilities,
      clientInfo: { name: "tasks-proxy-test", version: "1" },
    });
    const plain = await wire.request("initialize", params({}));
    const declaring = await wire.request(
      "initialize",
      params({ extensions: { [TASKS_EXTENSION_ID]: {} } }),
    );

    expect(JSON.stringify(plain.result.capabilities)).toBe(
      JSON.stringify({
        resources: { subscribe: true, listChanged: true },
        tools: { listChanged: true },
        logging: {},
        prompts: {},
      }),
    );
    expect(declaring.result.capabilities).toEqual({
      ...plain.result.capabilities,
      extensions: { [TASKS_EXTENSION_ID]: {} },
    });
  });

  test("a non-declaring call is forwarded without the relay and answered synchronously", async () => {
    const client = daemon({ toolResult: { content: [{ type: "text", text: "sync" }] } });
    const wire = await connect(client);

    const frame = await wire.call("observe", false);

    expect(frame.result).toEqual({ content: [{ type: "text", text: "sync" }] });
    expect(client.callToolOptions).toEqual([undefined]);
  });

  test("a declaring call relays the declaration and returns the daemon's task handle unchanged", async () => {
    const client = daemon({
      toolResultFor: (toolName) => (toolName === "executePlan" ? CREATED : undefined),
    });
    const wire = await connect(client);

    const frame = await wire.call("executePlan", true);

    expect(JSON.stringify(frame.result)).toBe(JSON.stringify(CREATED));
    expect(client.callToolOptions).toEqual([
      { tasks: { ownerKey: expect.stringMatching(/^proxy-tasks:/), declared: true } },
    ]);
  });

  test("a declaring startDevice runs as a task and later calls route to the session it completed with", async () => {
    const booted = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            platform: "android",
            runtime: { deviceId: "emulator-5554", session: { sessionUuid: "booted-session" } },
          }),
        },
      ],
    };
    let status = "working";
    const client = daemon({
      toolResultFor: (toolName) => (toolName === "startDevice" ? CREATED : undefined),
      onRelayTaskMethod: () => ({
        ...COMPLETED,
        status,
        ...(status === "completed" ? { result: booted } : { result: undefined }),
      }),
    });
    const wire = await connect(client);

    const created = await wire.call("startDevice", true);
    await wire.task("tasks/get", { taskId: "task-1" });
    await wire.call("observe", false);
    status = "completed";
    const done = await wire.task("tasks/get", { taskId: "task-1" });
    await wire.task("tasks/get", { taskId: "task-1" });
    await wire.call("observe", false);

    expect(JSON.stringify(created.result)).toBe(JSON.stringify(CREATED));
    expect(client.callToolOptions[0]?.tasks?.declared).toBe(true);
    expect(done.result.result).toEqual(booted);
    const routed = client.callToolCalls.filter((call) => call.toolName === "observe");
    expect(routed.map((call) => call.params.sessionUuid)).toEqual([undefined, "booted-session"]);
    // Binding claims the session's liveness ownership once; later keeper ticks only renew it.
    const claims = client.callDaemonMethodCalls.filter(
      (call) =>
        call.method === "daemon/heartbeat" &&
        call.params.sessionId === "booted-session" &&
        call.params.claimLivenessOwnership === true,
    );
    expect(claims).toHaveLength(1);
  });

  test("tasks/get, tasks/update and tasks/cancel reach the daemon under the call's owner key", async () => {
    const client = daemon({
      toolResultFor: () => CREATED,
      onRelayTaskMethod: (method) =>
        method === "tasks/get" ? COMPLETED : { resultType: "complete" },
    });
    const wire = await connect(client);
    await wire.call("executePlan", true);
    const ownerKey = client.callToolOptions[0]?.tasks?.ownerKey;
    if (ownerKey === undefined) {
      throw new Error("The task call must carry an owner key");
    }

    const got = await wire.task("tasks/get", { taskId: "task-1" });
    const updated = await wire.task("tasks/update", {
      taskId: "task-1",
      inputResponses: { confirm: { action: "accept" } },
    });
    const cancelled = await wire.task("tasks/cancel", { taskId: "task-1" });

    expect(JSON.stringify(got.result)).toBe(JSON.stringify(COMPLETED));
    expect(updated.result).toEqual({ resultType: "complete" });
    expect(cancelled.result).toEqual({ resultType: "complete" });
    const tasks = { ownerKey, declared: true };
    expect(client.relayTaskCalls).toEqual([
      { method: "tasks/get", params: { taskId: "task-1" }, tasks },
      {
        method: "tasks/update",
        params: { taskId: "task-1", inputResponses: { confirm: { action: "accept" } } },
        tasks,
      },
      { method: "tasks/cancel", params: { taskId: "task-1" }, tasks },
    ]);
  });

  test("a tasks/* request without the declaration answers -32021 without reaching the daemon", async () => {
    const client = daemon();
    const wire = await connect(client);

    const frame = await wire.task("tasks/get", { taskId: "task-1" }, false);

    expect(frame.error).toEqual({
      code: -32021,
      message: "Missing required client capability",
      data: { requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } } },
    });
    expect(client.relayTaskCalls).toEqual([]);
  });

  test("the daemon's JSON-RPC error is answered unchanged", async () => {
    const wire = await connect(
      daemon({
        onRelayTaskMethod: () => {
          throw Object.assign(
            new Error("MCP error -32602: Failed to retrieve task: Task has expired"),
            {
              code: -32602,
              jsonRpcError: { code: -32602, message: "Failed to retrieve task: Task has expired" },
            },
          );
        },
      }),
    );

    const frame = await wire.task("tasks/get", { taskId: "task-1" });

    expect(frame.error).toEqual({
      code: -32602,
      message: "Failed to retrieve task: Task has expired",
    });
  });

  test("a daemon restart mid-task reconnects and answers from the restarted daemon", async () => {
    const before = daemon({
      onRelayTaskMethod: () => {
        throw new DaemonUnavailableError("Socket connection closed");
      },
    });
    const interrupted = {
      ...COMPLETED,
      status: "failed",
      statusMessage: "Task interrupted",
      result: undefined,
      error: { code: -32603, message: "Task interrupted" },
    };
    const after = daemon({ onRelayTaskMethod: () => interrupted });
    const wire = await connect(before, after);

    const frame = await wire.task("tasks/get", { taskId: "task-1" });

    expect(frame.result).toEqual(JSON.parse(JSON.stringify(interrupted)));
    expect(before.relayTaskCalls).toHaveLength(1);
    expect(after.relayTaskCalls).toHaveLength(1);
    expect(after.relayTaskCalls[0].tasks).toEqual(before.relayTaskCalls[0].tasks);
  });

  test("a daemon that stays unreachable is an error, never an invented task status", async () => {
    const gone = daemon({
      onRelayTaskMethod: () => {
        throw new DaemonUnavailableError("Socket connection closed");
      },
    });
    const wire = await connect(gone);

    const frame = await wire.task("tasks/get", { taskId: "task-1" });

    expect(frame.result).toBeUndefined();
    expect(frame.error.code).toBe(-32603);
  });
});
