import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonClient } from "../../src/daemon/client/client";
import { DAEMON_VERSION } from "../../src/daemon/wire/constants";
import {
  DaemonConnectionSessionReleasedError,
  DaemonMcpProxy,
} from "../../src/daemon/daemonMcpProxy";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/daemon/sessionReleaseBroadcast";
import { logger } from "../../src/utils/logger";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

/*
 * `DaemonMcpProxy` relays the MCP Tasks extension (#4668) under one owner key per proxy, and a
 * task poll is never held back by the state of this proxy's device sessions: a released (fenced)
 * binding still refuses device calls, but tasks/get keeps reaching the daemon.
 */

const ANDROID = { sessionUuid: "android-session", deviceId: "emulator-5554" };

function deviceStartResult() {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          platform: "android",
          runtime: { deviceId: ANDROID.deviceId, session: { sessionUuid: ANDROID.sessionUuid } },
        }),
      },
    ],
  };
}

describe("DaemonMcpProxy task relay (#4668)", () => {
  let client: FakeDaemonClient;
  let proxy: DaemonMcpProxy;
  let spies: Array<ReturnType<typeof spyOn>>;

  beforeEach(() => {
    client = new FakeDaemonClient({
      toolResultFor: (name) => (name === "getAndroid" ? deviceStartResult() : undefined),
      onRelayTaskMethod: (_method, params) => ({ resultType: "complete", ...params }),
    });
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    spies = [
      spyOn(DaemonClient, "isAvailable").mockResolvedValue(true),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "info").mockImplementation(() => {}),
    ];
    proxy = new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager,
      autoStartDaemon: false,
      timer: new FakeTimer(),
      idGenerator: new FakeIdGenerator(),
    });
  });

  afterEach(async () => {
    await proxy.close();
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  test("declared calls and relayed tasks/* share one owner key for the proxy's lifetime", async () => {
    await proxy.callTool("observe", {}, undefined, undefined, undefined, { declaresTasks: true });
    await proxy.relayTaskMethod("tasks/get", { taskId: "t-1" }, true);
    await proxy.relayTaskMethod("tasks/cancel", { taskId: "t-1" }, true);

    // An absent key becomes "", which the prefix assertion rejects.
    const ownerKey = client.callToolOptions[0]?.tasks?.ownerKey ?? "";
    expect(ownerKey).toStartWith("proxy-tasks:");
    expect(client.relayTaskCalls.map((call) => call.tasks)).toEqual([
      { ownerKey, declared: true },
      { ownerKey, declared: true },
    ]);
  });

  test("an undeclared call carries no relay and mints no owner key", async () => {
    await proxy.callTool("observe", {});

    expect(client.callToolOptions).toEqual([undefined]);
  });

  test("a released binding fences device calls but not task polling", async () => {
    await proxy.callTool("getAndroid", {});
    client.emitNotification(
      SESSION_RELEASED_NOTIFICATION_METHOD,
      ANDROID.sessionUuid,
      "heartbeat-timeout",
    );
    await expect(proxy.callTool("tapOn", { text: "OK" })).rejects.toBeInstanceOf(
      DaemonConnectionSessionReleasedError,
    );

    const polled = await proxy.relayTaskMethod("tasks/get", { taskId: "t-1" }, true);

    expect(polled).toEqual({ resultType: "complete", taskId: "t-1" });
    expect(client.relayTaskCalls).toHaveLength(1);
  });
});

const STARTED = { sessionUuid: "task-started-session", deviceId: "emulator-5556" };

function startedDeviceResult() {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          platform: "android",
          runtime: { deviceId: STARTED.deviceId, session: { sessionUuid: STARTED.sessionUuid } },
        }),
      },
    ],
  };
}

function startDeviceTask(taskId: string) {
  return {
    resultType: "task",
    taskId,
    status: "working",
    createdAt: "2026-10-18T00:00:00.000Z",
    lastUpdatedAt: "2026-10-18T00:00:00.000Z",
    ttlMs: null,
  };
}

/*
 * A device-binding call relayed as a task (#4668) binds the session its completed result names,
 * exactly as the synchronous call would have, once, and only when the task completed.
 */
describe("DaemonMcpProxy binds a device-binding task from its completed result (#4668)", () => {
  let clients: FakeDaemonClient[];
  let proxy: DaemonMcpProxy;
  let spies: Array<ReturnType<typeof spyOn>>;
  /** What the daemon answers the next tasks/get with, per task id. */
  let taskAnswers: Map<string, Record<string, unknown>>;

  function getAnswer(taskId: string): Record<string, unknown> {
    const answer = taskAnswers.get(taskId);
    if (!answer) {
      throw Object.assign(new Error("Task not found"), {
        jsonRpcError: { code: -32602, message: "Failed to retrieve task: Task not found" },
      });
    }
    return answer;
  }

  function newClient(): FakeDaemonClient {
    const client = new FakeDaemonClient({
      toolResultFor: (name) => (name === "startDevice" ? startDeviceTask("boot-1") : undefined),
      onRelayTaskMethod: (method, params) =>
        method === "tasks/get" ? getAnswer(String(params.taskId)) : { resultType: "complete" },
    });
    clients.push(client);
    return client;
  }

  function settle(status: string, extra: Record<string, unknown> = {}): void {
    taskAnswers.set("boot-1", {
      ...startDeviceTask("boot-1"),
      status,
      ...extra,
    });
  }

  function heartbeatsFor(sessionUuid: string): number {
    return clients
      .flatMap((client) => client.callDaemonMethodCalls)
      .filter((call) => call.method === "daemon/heartbeat" && call.params.sessionId === sessionUuid)
      .length;
  }

  async function untargetedSession(): Promise<unknown> {
    await proxy.callTool("pressButton", { button: "home" });
    return clients.at(-1)?.callToolCalls.at(-1)?.params.sessionUuid;
  }

  async function startAsTask(): Promise<Record<string, unknown>> {
    return proxy.callTool("startDevice", { platform: "android" }, undefined, undefined, undefined, {
      declaresTasks: true,
    });
  }

  beforeEach(() => {
    clients = [];
    taskAnswers = new Map();
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    spies = [
      spyOn(DaemonClient, "isAvailable").mockResolvedValue(true),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "info").mockImplementation(() => {}),
    ];
    proxy = new DaemonMcpProxy({
      clientFactory: () => newClient(),
      daemonManager,
      autoStartDaemon: false,
      timer: new FakeTimer(),
      idGenerator: new FakeIdGenerator(),
    });
  });

  afterEach(async () => {
    await proxy.close();
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  test("a declared startDevice is relayed as a task and binds nothing until it completes", async () => {
    const created = await startAsTask();
    settle("working");
    await proxy.relayTaskMethod("tasks/get", { taskId: "boot-1" }, true);

    expect(created).toMatchObject({ resultType: "task", taskId: "boot-1" });
    expect(clients[0]?.callToolOptions[0]?.tasks?.declared).toBe(true);
    expect(await untargetedSession()).toBeUndefined();
  });

  test("the completed task binds its session and later calls route to it", async () => {
    await startAsTask();
    settle("completed", { result: startedDeviceResult() });

    const polled = await proxy.relayTaskMethod("tasks/get", { taskId: "boot-1" }, true);

    expect(polled).toMatchObject({ status: "completed", result: startedDeviceResult() });
    expect(heartbeatsFor(STARTED.sessionUuid)).toBe(1);
    expect(await untargetedSession()).toBe(STARTED.sessionUuid);
  });

  test("repeated and concurrent polls of a completed task bind it once", async () => {
    await startAsTask();
    settle("completed", { result: startedDeviceResult() });

    await Promise.all([
      proxy.relayTaskMethod("tasks/get", { taskId: "boot-1" }, true),
      proxy.relayTaskMethod("tasks/get", { taskId: "boot-1" }, true),
    ]);
    await proxy.relayTaskMethod("tasks/get", { taskId: "boot-1" }, true);

    expect(heartbeatsFor(STARTED.sessionUuid)).toBe(1);
    expect(await untargetedSession()).toBe(STARTED.sessionUuid);
  });

  test.each([
    ["failed", { error: { code: -32603, message: "boot failed" } }],
    ["cancelled", {}],
  ])("a %s task binds nothing, even if a later poll reports a result", async (status, extra) => {
    await startAsTask();
    settle(status, extra);
    await proxy.relayTaskMethod("tasks/get", { taskId: "boot-1" }, true);
    settle("completed", { result: startedDeviceResult() });
    await proxy.relayTaskMethod("tasks/get", { taskId: "boot-1" }, true);

    expect(heartbeatsFor(STARTED.sessionUuid)).toBe(0);
    expect(await untargetedSession()).toBeUndefined();
  });

  test("a task the daemon no longer knows binds nothing", async () => {
    await startAsTask();

    await expect(
      proxy.relayTaskMethod("tasks/get", { taskId: "boot-1" }, true),
    ).rejects.toMatchObject({ jsonRpcError: { code: -32602 } });
    settle("completed", { result: startedDeviceResult() });
    await proxy.relayTaskMethod("tasks/get", { taskId: "boot-1" }, true);

    expect(await untargetedSession()).toBeUndefined();
  });

  test("a session released before the completed poll is not resurrected", async () => {
    await startAsTask();
    clients[0]?.emitNotification(
      SESSION_RELEASED_NOTIFICATION_METHOD,
      STARTED.sessionUuid,
      "heartbeat-timeout",
    );
    settle("completed", { result: startedDeviceResult() });

    await expect(proxy.relayTaskMethod("tasks/get", { taskId: "boot-1" }, true)).rejects.toThrow(
      STARTED.sessionUuid,
    );
    expect(await untargetedSession()).toBeUndefined();
  });

  test("a poll after the proxy reconnected mid-task still binds once", async () => {
    await startAsTask();
    settle("working");
    await proxy.relayTaskMethod("tasks/get", { taskId: "boot-1" }, true);

    clients[0]?.emitConnectionClosed();
    settle("completed", { result: startedDeviceResult() });
    await proxy.relayTaskMethod("tasks/get", { taskId: "boot-1" }, true);
    await proxy.relayTaskMethod("tasks/get", { taskId: "boot-1" }, true);

    expect(clients.length).toBeGreaterThan(1);
    const ownerKeys = new Set(
      clients.flatMap((client) => client.relayTaskCalls.map((call) => call.tasks.ownerKey)),
    );
    expect(ownerKeys.size).toBe(1);
    expect(heartbeatsFor(STARTED.sessionUuid)).toBe(1);
    expect(await untargetedSession()).toBe(STARTED.sessionUuid);
  });

  test("an undeclared startDevice binds from its synchronous result as before", async () => {
    taskAnswers.clear();
    const sync = new FakeDaemonClient({
      toolResultFor: (name) => (name === "startDevice" ? startedDeviceResult() : undefined),
    });
    clients.push(sync);
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    const syncProxy = new DaemonMcpProxy({
      clientFactory: () => sync,
      daemonManager,
      autoStartDaemon: false,
      timer: new FakeTimer(),
      idGenerator: new FakeIdGenerator(),
    });
    try {
      const result = await syncProxy.callTool("startDevice", { platform: "android" });
      await syncProxy.callTool("pressButton", { button: "home" });

      expect(result).toEqual(startedDeviceResult());
      expect(sync.callToolOptions).toEqual([undefined, undefined]);
      expect(sync.callToolCalls.at(-1)?.params.sessionUuid).toBe(STARTED.sessionUuid);
    } finally {
      await syncProxy.close();
    }
  });
});
