import { createTestUnixSocketServer } from "../helpers/createTestUnixSocketServer";
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../../src/daemon/sessionManager";
import type { DaemonResponse } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";
import { sendRawSocketRequest } from "./helpers/socketRequest";

/**
 * #11618: the `tools/call` forward keys are built from the pool's canonical device id. A handset
 * named by its wireless id serializes on the same `device:<id>` queue as a call naming its USB
 * serial, a watcher's read of it finds the holder, and the forwarded call carries the canonical id.
 */

const USB = "R5CT1234ABC";
const WIRELESS = "adb-R5CT1234ABC-AbCdEf._adb-tls-connect._tcp";
const UNFOLDED = "192.168.1.77:5555";
const OWNER = "owner";

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

/** A daemon whose pool has folded WIRELESS onto USB; OWNER holds USB. */
function fakeDaemonState(options: { poolFolds: boolean }) {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({
      hasSession: (sessionId: string) => sessionId === OWNER,
      getSession: (sessionId: string) => (sessionId === OWNER ? fakeSession(OWNER, USB) : null),
      getSessionForDevice: (deviceId: string) => (deviceId === USB ? OWNER : null),
      getDeviceLabels: () => undefined,
      releaseSession: async () => null,
    }),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
      resolveAutolockSessionForMcpSession: () => undefined,
      getDevice: () => null,
      ...(options.poolFolds
        ? {
            resolveAndroidCanonicalId: (deviceId: string) =>
              deviceId === WIRELESS ? USB : deviceId,
          }
        : {}),
    }),
    getDeviceSessionRegistry: () => ({ list: () => [] }),
  };
}

async function settleEventLoop(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

interface Forward {
  tag: string;
  args: Record<string, unknown>;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close();
  }
});

async function startServer(options: { poolFolds: boolean } = { poolFolds: true }) {
  const socketPath = join(tmpdir(), `mcp-alias-forward-${randomUUID()}.sock`);
  const blockers = new Map<string, PromiseWithResolvers<void>>();
  const forwards: Forward[] = [];
  const server = createTestUnixSocketServer(
    socketPath,
    "http://localhost:0/mcp",
    fakeDaemonState(options),
    new FakeTimer(),
    null,
    {},
    undefined,
    // The cold owner-generation probe costs ~250 ms on the first start in a process; these tests do not cover the lock.
    { bindLock: { acquire: () => true, release: () => {} } },
  );
  server.deviceReadToolCallClassifier = (name) => name === "observe";
  server.mcpClientFactory = async () => ({
    listTools: async () => ({ tools: [] }),
    callTool: async (request: unknown) => {
      const args = (request as { arguments: Record<string, unknown> }).arguments;
      const tag = String(args.tag);
      forwards.push({ tag, args });
      await blockers.get(tag)?.promise;
      return { content: [] };
    },
    listResources: async () => ({ resources: [] }),
    readResource: async () => ({ contents: [] }),
    listResourceTemplates: async () => ({ resourceTemplates: [] }),
    close: async () => {},
  });
  await server.start();
  closers.push(async () => {
    for (const blocker of blockers.values()) {
      blocker.resolve();
    }
    await server.close();
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
  });
  const call = (name: string, args: Record<string, unknown>): Promise<DaemonResponse> =>
    sendRawSocketRequest(socketPath, {
      id: randomUUID(),
      type: "mcp_request",
      method: "tools/call",
      params: { name, arguments: args },
    }).then(({ response }) => response);
  return {
    forwards,
    started: () => forwards.map((forward) => forward.tag),
    call,
    /** Starts a call that stays inside callTool until `release(tag)`. */
    async park(
      tag: string,
      name: string,
      args: Record<string, unknown>,
    ): Promise<{ response: Promise<DaemonResponse> }> {
      blockers.set(tag, Promise.withResolvers<void>());
      const response = call(name, { ...args, tag });
      await settleEventLoop();
      return { response };
    },
    release(tag: string) {
      blockers.get(tag)?.resolve();
      blockers.delete(tag);
    },
  };
}

describe("tools/call forward keys use the pool's canonical device id (#11618)", () => {
  test("a call naming the alias waits on the same device queue as one naming the USB serial", async () => {
    const s = await startServer();
    const { response: first } = await s.park("first", "tapOn", { deviceId: USB });
    expect(s.started()).toEqual(["first"]);

    const second = s.call("tapOn", { deviceId: WIRELESS, tag: "second" });
    await settleEventLoop();
    expect(s.started()).toEqual(["first"]);

    s.release("first");
    expect((await first).success).toBe(true);
    expect((await second).success).toBe(true);
    expect(s.started()).toEqual(["first", "second"]);
    expect(s.forwards.map((forward) => forward.args.deviceId)).toEqual([USB, USB]);
  });

  test("the holder's session call and an alias call share the device queue", async () => {
    const s = await startServer();
    const { response: plan } = await s.park("plan", "executePlan", { sessionUuid: OWNER });

    const byAlias = s.call("tapOn", { deviceId: WIRELESS, tag: "alias" });
    await settleEventLoop();
    expect(s.started()).toEqual(["plan"]);

    s.release("plan");
    await plan;
    await byAlias;
    expect(s.started()).toEqual(["plan", "alias"]);
  });

  test("a watcher's read by the alias finds the holder and runs on the read lane", async () => {
    const s = await startServer();
    const { response: plan } = await s.park("plan", "executePlan", { sessionUuid: OWNER });

    const watch = await s.call("observe", { deviceId: WIRELESS, tag: "watch" });

    expect(watch.success).toBe(true);
    expect(s.started()).toEqual(["plan", "watch"]);
    expect(s.forwards[1]!.args.deviceId).toBe(USB);
    s.release("plan");
    await plan;
  });

  test("killDevice's device.deviceId is forwarded as the canonical id", async () => {
    const s = await startServer();

    await s.call("killDevice", {
      device: { name: "Phone", deviceId: WIRELESS, platform: "android" },
      tag: "kill",
    });

    expect(s.forwards[0]!.args.device).toEqual({
      name: "Phone",
      deviceId: USB,
      platform: "android",
    });
  });

  test("an id the pool has not folded keeps its own queue and is forwarded unchanged", async () => {
    const s = await startServer();
    const { response: first } = await s.park("first", "tapOn", { deviceId: USB });

    const other = await s.call("tapOn", { deviceId: UNFOLDED, tag: "other" });

    expect(other.success).toBe(true);
    expect(s.started()).toEqual(["first", "other"]);
    expect(s.forwards[1]!.args.deviceId).toBe(UNFOLDED);
    s.release("first");
    await first;
  });

  test("a daemon state whose pool has no alias fold forwards ids as sent", async () => {
    const s = await startServer({ poolFolds: false });

    await s.call("tapOn", { deviceId: WIRELESS, tag: "raw" });

    expect(s.forwards[0]!.args.deviceId).toBe(WIRELESS);
  });
});
