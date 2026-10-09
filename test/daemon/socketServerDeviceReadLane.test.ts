import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonResponse } from "../../src/daemon/types";
import type { Session } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { sendRawSocketRequest } from "./helpers/socketRequest";

/**
 * #10969: a watcher's read of a held device runs on the device's read lane, so it never waits
 * behind the holder's in-flight control call on `device:<id>`. Control calls stay serialized.
 */

const READ_TOOLS = new Set(["observe"]);

function fakeSession(sessionId: string, assignedDevice: string): Session {
  return {
    sessionId,
    assignedDevice,
    platform: "android",
    createdAt: 0,
    lastUsedAt: 0,
    expiresAt: 60_000,
    cacheData: {},
    lastHeartbeat: 0,
    sessionTimeoutMs: 60_000,
    heartbeatTimeoutMs: 10_000,
    heartbeatTimeoutSource: "default",
    hasReceivedHeartbeat: false,
  };
}

function fakeDaemonState(sessionDevices: Map<string, string>) {
  const holderOf = (deviceId: string) =>
    [...sessionDevices].find(([, device]) => device === deviceId)?.[0] ?? null;
  return {
    isInitialized: () => true,
    getSessionManager: () => ({
      hasSession: (sessionId: string) => sessionDevices.has(sessionId),
      getSession: (sessionId: string) => {
        const device = sessionDevices.get(sessionId);
        return device ? fakeSession(sessionId, device) : null;
      },
      getSessionForDevice: holderOf,
      getDeviceLabels: () => undefined,
      releaseSession: async () => null,
    }),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
      resolveAutolockSessionForMcpSession: () => undefined,
      getDevice: () => null,
    }),
    getDeviceSessionRegistry: () => ({ list: () => [] }),
  };
}

async function settleEventLoop(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("UnixSocketServer device read lane (#10969)", () => {
  let socketPath: string;
  let server: UnixSocketServer;
  let sessionDevices: Map<string, string>;
  let blockers: Map<string, PromiseWithResolvers<void>>;
  let started: string[];

  function call(name: string, args: Record<string, unknown>): Promise<DaemonResponse> {
    return sendRawSocketRequest(socketPath, {
      id: randomUUID(),
      type: "mcp_request",
      method: "tools/call",
      params: { name, arguments: args },
    }).then(({ response }) => response);
  }

  /** Starts a call that stays inside callTool until `release(tag)`. */
  async function park(
    tag: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ response: Promise<DaemonResponse> }> {
    blockers.set(tag, Promise.withResolvers<void>());
    const response = call(name, { ...args, tag });
    await settleEventLoop();
    return { response };
  }

  function release(tag: string): void {
    blockers.get(tag)?.resolve();
    blockers.delete(tag);
  }

  beforeEach(async () => {
    socketPath = join(tmpdir(), `mcp-read-lane-${randomUUID()}.sock`);
    sessionDevices = new Map([["owner", "device-1"]]);
    blockers = new Map();
    started = [];
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      fakeDaemonState(sessionDevices),
      new FakeTimer(),
    );
    server.deviceReadToolCallClassifier = (name) => READ_TOOLS.has(name);
    server.mcpClientFactory = async () => ({
      listTools: async () => ({ tools: [] }),
      callTool: async (request: unknown) => {
        const args = (request as { arguments: Record<string, unknown> }).arguments;
        const tag = String(args.tag);
        started.push(tag);
        await blockers.get(tag)?.promise;
        return { content: [] };
      },
      listResources: async () => ({ resources: [] }),
      readResource: async () => ({ contents: [] }),
      listResourceTemplates: async () => ({ resourceTemplates: [] }),
      close: async () => {},
    });
    await server.start();
  });

  afterEach(async () => {
    for (const blocker of blockers.values()) {
      blocker.resolve();
    }
    await server.close();
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
  });

  test("a watcher's observe {deviceId} completes while the owner's executePlan is parked", async () => {
    const { response: plan } = await park("plan", "executePlan", { sessionUuid: "owner" });
    expect(started).toEqual(["plan"]);

    const watch = await call("observe", { deviceId: "device-1", tag: "watch" });

    expect(watch.success).toBe(true);
    expect(started).toEqual(["plan", "watch"]);
    release("plan");
    expect((await plan).success).toBe(true);
  });

  test("two control calls on the same held device still serialize", async () => {
    const { response: plan } = await park("plan", "executePlan", { sessionUuid: "owner" });
    const tap = call("tapOn", { deviceId: "device-1", tag: "tap" });
    await settleEventLoop();
    expect(started).toEqual(["plan"]);

    release("plan");
    expect((await plan).success).toBe(true);
    expect((await tap).success).toBe(true);
    expect(started).toEqual(["plan", "tap"]);
  });

  test("the holder's own read stays on the control lane", async () => {
    const { response: plan } = await park("plan", "executePlan", { sessionUuid: "owner" });
    const ownRead = call("observe", { sessionUuid: "owner", deviceId: "device-1", tag: "own" });
    await settleEventLoop();
    expect(started).toEqual(["plan"]);

    release("plan");
    expect((await plan).success).toBe(true);
    expect((await ownRead).success).toBe(true);
    expect(started).toEqual(["plan", "own"]);
  });

  test("watcher reads on one device serialize among themselves", async () => {
    const { response: first } = await park("read-1", "observe", { deviceId: "device-1" });
    const second = call("observe", { deviceId: "device-1", tag: "read-2" });
    await settleEventLoop();
    expect(started).toEqual(["read-1"]);

    release("read-1");
    expect((await first).success).toBe(true);
    expect((await second).success).toBe(true);
    expect(started).toEqual(["read-1", "read-2"]);
  });

  test("a read of a free device keeps the control lane, since it may run readiness", async () => {
    sessionDevices.clear();
    const { response: tap } = await park("tap", "tapOn", { deviceId: "device-1" });
    const read = call("observe", { deviceId: "device-1", tag: "read" });
    await settleEventLoop();
    expect(started).toEqual(["tap"]);

    release("tap");
    expect((await tap).success).toBe(true);
    expect((await read).success).toBe(true);
    expect(started).toEqual(["tap", "read"]);
  });
});
