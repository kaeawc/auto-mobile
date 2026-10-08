import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";

// #10050 x #9335: the proxy heartbeats and claims every session it holds, and all of
// them claim with the one harness-supplied stable owner token. A live-owner conflict
// on one held session never stops the proxy's other sessions.

const INTERVAL_MS = 2_000;
const LEASE_MS = 5_000;
const DEVICE_POOL = {
  refreshDevices: async () => 0,
  getStats: () => ({ total: 2, idle: 0, assigned: 2, error: 0 }),
};

function daemonStateFor(sessionManager: SessionManager): DaemonStateAccess {
  return {
    isInitialized: () => true,
    getSessionManager: () => sessionManager,
    getDevicePool: () => DEVICE_POOL,
    getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
  };
}

function matchingDaemonManager(): FakeDaemonManager {
  const manager = new FakeDaemonManager();
  manager.statusResult = { ...manager.statusResult, version: DAEMON_VERSION };
  return manager;
}

function deviceStartResult(sessionUuid: string): {
  content: Array<{ type: string; text: string }>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify({ runtime: { session: { sessionUuid } } }) }],
  };
}

interface HeartbeatReply {
  sessionId: string;
  token: unknown;
  claim: boolean;
  success: boolean;
  code?: string;
}

describe("held-session heartbeats under the daemon's live-owner rule (#10050)", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let replies: HeartbeatReply[];
  let mintedBy: Record<string, string>;
  let clients: FakeDaemonClient[];
  let toolRefusal: Error | undefined;
  let isAvailableSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  const proxies: DaemonMcpProxy[] = [];

  function daemonBackedClient(): FakeDaemonClient {
    const client = new FakeDaemonClient({
      toolResultFor: (name) => (mintedBy[name] ? deviceStartResult(mintedBy[name]) : undefined),
      onCallTool: () => {
        if (toolRefusal) {
          throw toolRefusal;
        }
      },
      onCallDaemonMethod: async (method, params) => {
        if (method !== "daemon/heartbeat") {
          return;
        }
        const response = await handleDaemonRequest(
          { id: "request-1", type: "daemon_request", method, params },
          daemonStateFor(sessionManager),
        );
        replies.push({
          sessionId: params.sessionId,
          token: params.livenessOwnerToken,
          claim: params.claimLivenessOwnership === true,
          success: response.success,
          code: response.code,
        });
        if (!response.success) {
          throw Object.assign(new Error(response.error), { code: response.code });
        }
      },
    });
    clients.push(client);
    return client;
  }

  function createProxy(options: {
    token?: string;
    initialSessionUuid?: string;
    leashMs?: number;
  }): DaemonMcpProxy {
    const proxy = new DaemonMcpProxy({
      clientFactory: () => daemonBackedClient(),
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer,
      idGenerator: new FakeIdGenerator(["minted-token"]),
      heartbeatTimeoutMs: options.leashMs ?? 10_000,
      heartbeatIntervalMs: INTERVAL_MS,
      livenessOwnerToken: options.token,
      ...(options.initialSessionUuid ? { initialSessionUuid: options.initialSessionUuid } : {}),
    });
    proxies.push(proxy);
    return proxy;
  }

  async function acquire(
    proxy: DaemonMcpProxy,
    tool: "getAndroid" | "getApple",
    sessionUuid: string,
  ): Promise<void> {
    mintedBy[tool] = sessionUuid;
    await proxy.callTool(tool, {});
  }

  function ownerOf(sessionId: string): string | undefined {
    return sessionManager.getSession(sessionId)?.livenessOwnerToken;
  }

  /** The (sorted) sessions heartbeated by the next keeper tick only. */
  async function tickSessions(): Promise<string[]> {
    const before = replies.length;
    await timer.advanceTimeAsync(INTERVAL_MS);
    return replies
      .slice(before)
      .map((reply) => reply.sessionId)
      .sort();
  }

  beforeEach(async () => {
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    replies = [];
    mintedBy = {};
    clients = [];
    toolRefusal = undefined;
    for (const [sessionId, device] of [
      ["android-session", "emulator-5554"],
      ["ios-session", "sim-1"],
    ] as const) {
      await sessionManager.createSession(
        sessionId,
        device,
        sessionId.startsWith("ios") ? "ios" : "android",
        60_000,
        LEASE_MS,
      );
    }
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const proxy of proxies.splice(0)) {
      await proxy.close();
    }
    isAvailableSpy.mockRestore();
    warnSpy.mockRestore();
    sessionManager.stopCleanupTimer();
  });

  test("a held session claims with the harness-supplied token, like the latest binding", async () => {
    const proxy = createProxy({ token: "harness-token" });
    await acquire(proxy, "getAndroid", "android-session");
    await acquire(proxy, "getApple", "ios-session");
    await tickSessions();

    expect(replies.length).toBeGreaterThanOrEqual(4);
    expect(new Set(replies.map((reply) => reply.token))).toEqual(new Set(["harness-token"]));
    expect(replies.every((reply) => reply.success)).toBe(true);
    expect(ownerOf("android-session")).toBe("harness-token");
    expect(ownerOf("ios-session")).toBe("harness-token");
  });

  test("a restarted proxy with the same token resumes every session it held without a conflict", async () => {
    const original = createProxy({ token: "harness-token" });
    await acquire(original, "getAndroid", "android-session");
    await acquire(original, "getApple", "ios-session");
    await tickSessions();
    await original.close();
    replies.length = 0;

    const restarted = createProxy({
      token: "harness-token",
      initialSessionUuid: "android-session",
    });
    await restarted.ensureConnected();
    await acquire(restarted, "getApple", "ios-session");
    await tickSessions();

    expect(replies.filter((reply) => !reply.success)).toEqual([]);
    expect(new Set(replies.map((reply) => reply.sessionId))).toEqual(
      new Set(["android-session", "ios-session"]),
    );
    expect(ownerOf("android-session")).toBe("harness-token");
    expect(ownerOf("ios-session")).toBe("harness-token");
  });

  test("a conflict on one held session leaves the others heartbeating and retries its claim", async () => {
    // Another harness already owns the android session with a live lease.
    const foreign = await handleDaemonRequest(
      {
        id: "foreign-claim",
        type: "daemon_request",
        method: "daemon/heartbeat",
        params: {
          sessionId: "android-session",
          livenessPolicy: "heartbeat",
          livenessOwnerToken: "other-harness",
          claimLivenessOwnership: true,
        },
      },
      daemonStateFor(sessionManager),
    );
    expect(foreign.success).toBe(true);
    // The claim keeps retrying through the foreign owner's lease plus its suspect grace
    // window (#10051) under the proxy's default 10s lease: its conflict leash covers
    // lease + grace (#10053) rather than the bare lease it used to be.
    const proxy = createProxy({ token: "harness-token" });
    await acquire(proxy, "getAndroid", "android-session");
    await acquire(proxy, "getApple", "ios-session");

    // android-session is held; ios-session is the latest binding.
    expect(await tickSessions()).toEqual(["android-session", "ios-session"]);
    expect(await tickSessions()).toEqual(["android-session", "ios-session"]);
    expect(ownerOf("android-session")).toBe("other-harness");
    expect(ownerOf("ios-session")).toBe("harness-token");
    const refused = replies.filter((reply) => reply.sessionId === "android-session");
    expect(refused.every((reply) => reply.code === "liveness_owner_conflict")).toBe(true);
    // The claim stays unsent, so every tick retries it rather than ticking non-claiming.
    expect(refused.every((reply) => reply.claim)).toBe(true);
    // The refusal is reported once, not on every tick.
    expect(
      warnSpy.mock.calls.filter(([message]) => String(message).includes("another live liveness")),
    ).toHaveLength(1);

    // Once the foreign lease and its suspect grace window (#10051) lapse, the
    // retried claim wins the session.
    await timer.advanceTimeAsync(INTERVAL_MS * 4 + SUSPECT_GRACE_MS);
    expect(ownerOf("android-session")).toBe("harness-token");
    expect(ownerOf("ios-session")).toBe("harness-token");
  });

  test("a conflict on the latest binding is reported once, never fails the keeper, and wins after expiry", async () => {
    await handleDaemonRequest(
      {
        id: "foreign-claim",
        type: "daemon_request",
        method: "daemon/heartbeat",
        params: {
          sessionId: "android-session",
          livenessPolicy: "heartbeat",
          livenessOwnerToken: "other-harness",
          claimLivenessOwnership: true,
        },
      },
      daemonStateFor(sessionManager),
    );
    const proxy = createProxy({
      token: "harness-token",
      initialSessionUuid: "android-session",
      leashMs: 40_000,
    });
    await proxy.ensureConnected();
    await tickSessions();
    await tickSessions();

    expect(ownerOf("android-session")).toBe("other-harness");
    expect(proxy.isConnected()).toBe(true);
    expect(
      warnSpy.mock.calls.filter(([message]) => String(message).includes("heartbeat failed")),
    ).toEqual([]);
    expect(
      warnSpy.mock.calls.filter(([message]) => String(message).includes("another live liveness")),
    ).toHaveLength(1);

    await timer.advanceTimeAsync(INTERVAL_MS * 4 + SUSPECT_GRACE_MS);
    expect(ownerOf("android-session")).toBe("harness-token");
  });

  test("a latest-binding conflict that outlasts lease plus grace stops claiming and fences the binding (#10664)", async () => {
    const foreignHeartbeat = async (claimLivenessOwnership: boolean): Promise<void> => {
      await handleDaemonRequest(
        {
          id: "foreign",
          type: "daemon_request",
          method: "daemon/heartbeat",
          params: {
            sessionId: "android-session",
            livenessPolicy: "heartbeat",
            livenessOwnerToken: "other-harness",
            ...(claimLivenessOwnership ? { claimLivenessOwnership: true } : {}),
          },
        },
        daemonStateFor(sessionManager),
      );
    };
    await foreignHeartbeat(true);
    const proxy = createProxy({ token: "harness-token", initialSessionUuid: "android-session" });
    await proxy.ensureConnected();

    // The foreign owner keeps its lease live past the conflict leash (lease plus grace plus one tick).
    for (let tick = 0; tick < 14; tick++) {
      await foreignHeartbeat(false);
      await timer.advanceTimeAsync(INTERVAL_MS);
    }

    const before = replies.length;
    await timer.advanceTimeAsync(INTERVAL_MS * 3);
    expect(replies.length).toBe(before);
    await foreignHeartbeat(false);
    expect(ownerOf("android-session")).toBe("other-harness");
    await expect(proxy.callTool("tapOn", {})).rejects.toMatchObject({
      reason: "liveness-owner-conflict",
    });
  });

  test("a held session whose conflict outlasts lease plus grace is dropped alone", async () => {
    const foreignHeartbeat = async (claimLivenessOwnership: boolean): Promise<void> => {
      await handleDaemonRequest(
        {
          id: "foreign",
          type: "daemon_request",
          method: "daemon/heartbeat",
          params: {
            sessionId: "android-session",
            livenessPolicy: "heartbeat",
            livenessOwnerToken: "other-harness",
            ...(claimLivenessOwnership ? { claimLivenessOwnership: true } : {}),
          },
        },
        daemonStateFor(sessionManager),
      );
    };
    await foreignHeartbeat(true);
    const proxy = createProxy({ token: "harness-token" });
    await acquire(proxy, "getAndroid", "android-session");
    await acquire(proxy, "getApple", "ios-session");

    // The foreign owner keeps its lease live, so the proxy's claim is refused for longer than
    // the conflict leash: the 10s lease plus the 10s grace plus one 2s tick (13 ticks of 2s).
    for (let tick = 0; tick < 13; tick++) {
      await foreignHeartbeat(false);
      await timer.advanceTimeAsync(INTERVAL_MS);
    }

    const androidBefore = replies.filter((reply) => reply.sessionId === "android-session").length;
    expect(await tickSessions()).toEqual(["ios-session"]);
    expect(await tickSessions()).toEqual(["ios-session"]);
    expect(replies.filter((reply) => reply.sessionId === "android-session")).toHaveLength(
      androidBefore,
    );
    expect(ownerOf("android-session")).toBe("other-harness");
    expect(ownerOf("ios-session")).toBe("harness-token");
  });

  /** Heartbeat `sessionId` as another owner, straight to the daemon handler. */
  async function foreignHeartbeat(
    sessionId: string,
    token: string,
    claimLivenessOwnership: boolean,
  ): Promise<void> {
    await handleDaemonRequest(
      {
        id: "foreign",
        type: "daemon_request",
        method: "daemon/heartbeat",
        params: {
          sessionId,
          livenessPolicy: "heartbeat",
          livenessOwnerToken: token,
          ...(claimLivenessOwnership ? { claimLivenessOwnership: true } : {}),
        },
      },
      daemonStateFor(sessionManager),
    );
  }

  function forwardedTools(): Array<{ toolName: string; params: Record<string, unknown> }> {
    return clients.flatMap((client) => client.callToolCalls);
  }

  describe("only minted or startup sessions are claimed (#10664)", () => {
    test("a session only named in args is forwarded but never claimed or heartbeated", async () => {
      await foreignHeartbeat("android-session", "other-harness", true);
      const proxy = createProxy({ token: "harness-token" });

      await proxy.callTool("tapOn", { sessionUuid: "android-session", x: 1, y: 2 });
      await tickSessions();
      await tickSessions();

      expect(forwardedTools()).toEqual([
        { toolName: "tapOn", params: { sessionUuid: "android-session", x: 1, y: 2 } },
      ]);
      expect(replies).toEqual([]);
      expect(ownerOf("android-session")).toBe("other-harness");
      // The binding still routes a later sessionless call to the named session.
      await proxy.callTool("observe", {});
      expect(forwardedTools().at(-1)).toEqual({
        toolName: "observe",
        params: { sessionUuid: "android-session" },
      });
      expect(replies).toEqual([]);
    });

    test("a minted session is claimed and heartbeated", async () => {
      const proxy = createProxy({ token: "harness-token" });
      await acquire(proxy, "getAndroid", "android-session");

      expect(replies[0]).toMatchObject({
        sessionId: "android-session",
        claim: true,
        success: true,
      });
      expect(await tickSessions()).toEqual(["android-session"]);
      expect(ownerOf("android-session")).toBe("harness-token");
    });

    test("a startup session is claimed and heartbeated", async () => {
      const proxy = createProxy({ token: "harness-token", initialSessionUuid: "android-session" });
      await proxy.ensureConnected();

      expect(replies[0]).toMatchObject({
        sessionId: "android-session",
        claim: true,
        success: true,
      });
      expect(await tickSessions()).toEqual(["android-session"]);
      expect(ownerOf("android-session")).toBe("harness-token");
    });

    test("naming a minted session in args keeps it claimed, and naming a foreign one never drops it (#9335)", async () => {
      await foreignHeartbeat("ios-session", "other-harness", true);
      const proxy = createProxy({ token: "harness-token" });
      await acquire(proxy, "getAndroid", "android-session");

      await proxy.callTool("tapOn", { sessionUuid: "ios-session" });
      // The minted session stays held while the args-named one is the latest binding.
      expect(await tickSessions()).toEqual(["android-session"]);
      await proxy.callTool("tapOn", { sessionUuid: "android-session" });
      expect(await tickSessions()).toEqual(["android-session"]);

      expect(replies.filter((reply) => reply.sessionId === "ios-session")).toEqual([]);
      expect(ownerOf("android-session")).toBe("harness-token");
      expect(ownerOf("ios-session")).toBe("other-harness");
    });

    test("a second proxy naming another owner's session cannot inherit it after that lease lapses", async () => {
      // The first owner claims the session, then goes silent without releasing it.
      await foreignHeartbeat("android-session", "first-proxy", true);
      const second = createProxy({ token: "second-proxy" });
      await second.callTool("tapOn", { sessionUuid: "android-session" });

      // Well past the first owner's lease plus its suspect grace window (#10051).
      await timer.advanceTimeAsync(LEASE_MS + SUSPECT_GRACE_MS + INTERVAL_MS * 4);

      expect(replies).toEqual([]);
      expect(ownerOf("android-session")).not.toBe("second-proxy");
    });

    test("a daemon refusal of an args-named call is surfaced and claims nothing", async () => {
      await foreignHeartbeat("android-session", "other-harness", true);
      toolRefusal = new Error("Session android-session is owned by another liveness owner");
      const proxy = createProxy({ token: "harness-token" });

      await expect(proxy.callTool("tapOn", { sessionUuid: "android-session" })).rejects.toThrow(
        "owned by another liveness owner",
      );
      await tickSessions();

      expect(replies).toEqual([]);
      expect(ownerOf("android-session")).toBe("other-harness");
    });
  });
});
