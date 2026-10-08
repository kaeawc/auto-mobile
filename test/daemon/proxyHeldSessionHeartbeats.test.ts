import { describe, expect, test, spyOn, beforeEach, afterEach } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { LIVENESS_RECOVERY_ATTEMPTS } from "../../src/daemon/proxyLivenessRecovery";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";

// Issue #9335 (child of #10049): a proxy owns liveness for every device session it
// holds, not only its latest binding. `boundSessionUuid` moves to the newest
// session on each acquisition, so the earlier sessions used to receive no
// heartbeat and were reaped with `heartbeat-timeout` while the proxy was healthy.

const INTERVAL_MS = 2_000;
const TIMEOUT_MS = 10_000;

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

interface HeartbeatCall {
  sessionId: string;
  claimLivenessOwnership: boolean;
  livenessOwnerToken: string;
}

describe("proxy heartbeats every session it holds (issue #9335)", () => {
  let timer: FakeTimer;
  let client: FakeDaemonClient;
  let failHeartbeatFor: Set<string>;
  let mintedBy: Record<string, string>;
  let proxy: DaemonMcpProxy;
  let isAvailableSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;

  function createProxy(initialSessionUuid?: string): DaemonMcpProxy {
    return new DaemonMcpProxy({
      clientFactory: () => client,
      daemonManager: matchingDaemonManager(),
      autoStartDaemon: false,
      timer,
      idGenerator: new FakeIdGenerator(),
      heartbeatTimeoutMs: TIMEOUT_MS,
      heartbeatIntervalMs: INTERVAL_MS,
      ...(initialSessionUuid ? { initialSessionUuid } : {}),
    });
  }

  function heartbeats(): HeartbeatCall[] {
    return client.callDaemonMethodCalls
      .filter((call) => call.method === "daemon/heartbeat")
      .map((call) => ({
        sessionId: call.params.sessionId,
        claimLivenessOwnership: call.params.claimLivenessOwnership === true,
        livenessOwnerToken: call.params.livenessOwnerToken,
      }));
  }

  /** Heartbeat session ids sent by the next keeper tick only. */
  async function tickSessions(): Promise<string[]> {
    const before = heartbeats().length;
    await timer.advanceTimeAsync(INTERVAL_MS);
    return heartbeats()
      .slice(before)
      .map((call) => call.sessionId)
      .sort();
  }

  async function acquire(tool: "getAndroid" | "getApple", sessionUuid: string): Promise<void> {
    mintedBy[tool] = sessionUuid;
    await proxy.callTool(tool, {});
  }

  beforeEach(() => {
    timer = new FakeTimer();
    failHeartbeatFor = new Set();
    mintedBy = {};
    client = new FakeDaemonClient({
      toolResultFor: (name) => (mintedBy[name] ? deviceStartResult(mintedBy[name]) : undefined),
      onCallDaemonMethod: (method, params) => {
        if (method === "daemon/heartbeat" && failHeartbeatFor.has(params.sessionId)) {
          throw new Error(`heartbeat rejected for ${params.sessionId}`);
        }
      },
    });
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    proxy = createProxy();
  });

  afterEach(async () => {
    await proxy.close();
    isAvailableSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test("a single session still costs exactly one heartbeat per tick", async () => {
    await acquire("getAndroid", "android-session");
    expect(await tickSessions()).toEqual(["android-session"]);
    expect(await tickSessions()).toEqual(["android-session"]);
  });

  test("heartbeats both sessions after acquiring a second device", async () => {
    await acquire("getAndroid", "android-session");
    await acquire("getApple", "ios-session");

    expect(await tickSessions()).toEqual(["android-session", "ios-session"]);
    expect(await tickSessions()).toEqual(["android-session", "ios-session"]);
  });

  test("claims each session once, with the proxy's single owner token", async () => {
    await acquire("getAndroid", "android-session");
    await acquire("getApple", "ios-session");
    await tickSessions();
    await tickSessions();

    const calls = heartbeats();
    const claimsBySession = (sessionId: string) =>
      calls.filter((call) => call.sessionId === sessionId && call.claimLivenessOwnership).length;
    expect(claimsBySession("android-session")).toBe(1);
    expect(claimsBySession("ios-session")).toBe(1);
    expect(new Set(calls.map((call) => call.livenessOwnerToken)).size).toBe(1);
    expect(calls.every((call) => call.livenessOwnerToken.length > 0)).toBe(true);
  });

  test("heartbeats three sessions: the initial session plus two acquired ones", async () => {
    await proxy.close();
    proxy = createProxy("initial-session");
    await acquire("getAndroid", "android-session");
    await acquire("getApple", "ios-session");

    expect(await tickSessions()).toEqual(["android-session", "initial-session", "ios-session"]);
    expect(await tickSessions()).toEqual(["android-session", "initial-session", "ios-session"]);
  });

  test("stops heartbeating a held session once the daemon releases it", async () => {
    await acquire("getAndroid", "android-session");
    await acquire("getApple", "ios-session");
    expect(await tickSessions()).toEqual(["android-session", "ios-session"]);

    client.emitNotification(
      SESSION_RELEASED_NOTIFICATION_METHOD,
      "android-session",
      "device-killed",
    );

    expect(await tickSessions()).toEqual(["ios-session"]);
  });

  test("keeps heartbeating held sessions after the latest binding is released", async () => {
    await acquire("getAndroid", "android-session");
    await acquire("getApple", "ios-session");

    client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, "ios-session", "device-killed");

    expect(await tickSessions()).toEqual(["android-session"]);
    expect(await tickSessions()).toEqual(["android-session"]);
  });

  test("idles the keeper once the last session is released", async () => {
    await acquire("getAndroid", "android-session");
    await acquire("getApple", "ios-session");
    client.emitNotification(SESSION_RELEASED_NOTIFICATION_METHOD, "ios-session", "device-killed");
    client.emitNotification(
      SESSION_RELEASED_NOTIFICATION_METHOD,
      "android-session",
      "device-killed",
    );
    await timer.advanceTimeAsync(0);

    expect(timer.getPendingIntervalCount()).toBe(0);
    expect(await tickSessions()).toEqual([]);
  });

  test("one session's failing heartbeat leaves the others ticking", async () => {
    await proxy.close();
    proxy = createProxy("initial-session");
    await acquire("getAndroid", "android-session");
    await acquire("getApple", "ios-session");

    failHeartbeatFor.add("android-session");
    // The failed heartbeat is followed by a recovery attempt for that session (#10053), so it
    // appears more than once in the first tick, then sits out the ticks while it recovers.
    expect(await tickSessions()).toEqual([
      "android-session",
      "android-session",
      "initial-session",
      "ios-session",
    ]);
    expect(await tickSessions()).toEqual(["initial-session", "ios-session"]);
    expect(warnSpy).toHaveBeenCalled();

    // The first recovery attempt that the daemon acknowledges returns the session to the cadence.
    failHeartbeatFor.clear();
    await timer.advanceTimeAsync(INTERVAL_MS * 3);
    expect(await tickSessions()).toEqual(["android-session", "initial-session", "ios-session"]);
  });

  test("a held session whose claim never landed claims on a later tick", async () => {
    failHeartbeatFor.add("android-session");
    await acquire("getAndroid", "android-session");
    await acquire("getApple", "ios-session");
    failHeartbeatFor.clear();

    const before = heartbeats().length;
    await timer.advanceTimeAsync(INTERVAL_MS);
    const tick = heartbeats().slice(before);
    expect(tick.find((call) => call.sessionId === "android-session")?.claimLivenessOwnership).toBe(
      true,
    );
    expect(tick.find((call) => call.sessionId === "ios-session")?.claimLivenessOwnership).toBe(
      false,
    );
  });

  test("a failing latest binding does not stop held sessions", async () => {
    await acquire("getAndroid", "android-session");
    await acquire("getApple", "ios-session");

    failHeartbeatFor.add("ios-session");
    // The failing latest binding gets a recovery attempt (#10053) and then sits out the ticks
    // while it recovers, heard from only through its spaced recovery attempts; the held session
    // keeps heartbeating on every tick throughout.
    expect(await tickSessions()).toEqual(["android-session", "ios-session", "ios-session"]);
    const later = [await tickSessions(), await tickSessions()];
    for (const tick of later) {
      expect(tick).toContain("android-session");
    }
    const iosRecoveryAttempts = later.flat().filter((sessionId) => sessionId === "ios-session");
    expect(iosRecoveryAttempts.length).toBeLessThan(LIVENESS_RECOVERY_ATTEMPTS);
  });

  test("rebinding does not duplicate timers or heartbeats", async () => {
    await acquire("getAndroid", "android-session");
    const intervalsAfterFirst = timer.getPendingIntervalCount();
    await acquire("getApple", "ios-session");
    await acquire("getAndroid", "android-session-2");

    expect(timer.getPendingIntervalCount()).toBe(intervalsAfterFirst);
    expect(await tickSessions()).toEqual(["android-session", "android-session-2", "ios-session"]);
  });

  test("returning to a held session by explicit sessionUuid does not double-heartbeat it", async () => {
    await acquire("getAndroid", "android-session");
    await acquire("getApple", "ios-session");
    await proxy.callTool("observe", { sessionUuid: "android-session" });
    // The explicit call's own immediate heartbeat is still settling; let it land
    // so the next tick is a clean, un-coalesced epoch.
    await timer.advanceTimeAsync(INTERVAL_MS);

    expect(await tickSessions()).toEqual(["android-session", "ios-session"]);
  });

  test("leaks no timer and sends no heartbeat after close", async () => {
    await acquire("getAndroid", "android-session");
    await acquire("getApple", "ios-session");
    expect(timer.getPendingIntervalCount()).toBe(1);

    await proxy.close();

    expect(timer.getPendingIntervalCount()).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    const sent = heartbeats().length;
    await timer.advanceTimeAsync(INTERVAL_MS * 3);
    expect(heartbeats().length).toBe(sent);
  });
});
