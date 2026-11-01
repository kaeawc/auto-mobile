import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test, mock } from "bun:test";
import { createProxyMcpServer, noActiveDeviceSessionResult } from "../../src/server/proxyServer";
import {
  DaemonBoundSessionExpiredError,
  DaemonConnectionSessionReleasedError,
  DaemonMcpProxy,
  RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS,
} from "../../src/daemon/daemonMcpProxy";
import { DaemonClient, DaemonUnavailableError } from "../../src/daemon/client/client";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { SessionManager } from "../../src/daemon/sessionManager";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DAEMON_VERSION } from "../../src/daemon/wire/constants";
import {
  DAEMON_STALL_RESUMED_CODE,
  DAEMON_RESTART_RESUMED_CODE,
  type LivenessHandover,
} from "../../src/daemon/proxyLivenessRecovery";
import { DAEMON_INSTANCE_CHANGED_CODE } from "../../src/daemon/types";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntilQuiescent, settleByFakeEvents } from "../helpers/fakeTimerStepping";
import { logger } from "../../src/utils/logger";
import type { Timer } from "../../src/utils/SystemTimer";
import { SUSPECT_GRACE_MS } from "../../src/daemon/wire/sessionLivenessWindows";

// #10989: a daemon frozen for longer than the lease (SIGSTOP) that then resumes by itself
// (SIGCONT), still the same process holding the same sessions. The proxy, the daemon's real
// heartbeat handler, session manager and heartbeat monitor all run on one fake clock.

class LivenessTimer extends FakeTimer {
  override advanceTimeAsync(ms: number): Promise<void> {
    return super.advanceTimeAsync(ms, () => drainUntilQuiescent(this));
  }
}

/**
 * The daemon's view of the clock. While the daemon is stopped its timers do not fire (they fire,
 * late, when it resumes) and the requests it is sent wait in the socket until then; the clock
 * itself keeps running, as the monotonic clock does through SIGSTOP.
 */
class StoppableDaemonTimer implements Timer {
  private stopped = false;
  private readonly deferred: Array<() => void> = [];

  constructor(private readonly base: FakeTimer) {}

  stop(): void {
    this.stopped = true;
  }

  /** SIGCONT: run what came due while stopped, timers first, then queued requests. */
  resume(): void {
    this.stopped = false;
    for (const run of this.deferred.splice(0)) {
      run();
    }
  }

  isStopped(): boolean {
    return this.stopped;
  }

  /** Run `work` now, or when the daemon resumes. */
  whenRunning<T>(work: () => Promise<T>): Promise<T> {
    if (!this.stopped) {
      return work();
    }
    return new Promise<T>((resolve, reject) => {
      this.deferred.push(() => {
        void work().then(resolve, reject);
      });
    });
  }

  private gated(callback: () => void): () => void {
    let queued = false;
    return () => {
      if (!this.stopped) {
        callback();
        return;
      }
      if (!queued) {
        queued = true;
        this.deferred.unshift(() => {
          queued = false;
          callback();
        });
      }
    };
  }

  now(): number {
    return this.base.now();
  }
  sleep(ms: number): Promise<void> {
    return this.base.sleep(ms);
  }
  setTimeout(callback: () => void, ms: number): NodeJS.Timeout {
    return this.base.setTimeout(this.gated(callback), ms);
  }
  clearTimeout(handle: NodeJS.Timeout): void {
    this.base.clearTimeout(handle);
  }
  setInterval(callback: () => void, ms: number): NodeJS.Timeout {
    return this.base.setInterval(this.gated(callback), ms);
  }
  clearInterval(handle: NodeJS.Timeout): void {
    this.base.clearInterval(handle);
  }
}

/** The stdio defaults: a 4 s lease heartbeated every 2 s. */
const LEASE_MS = 4_000;
const INTERVAL_MS = 2_000;
const STOP_MS = 15_000;
const DEVICES: Record<string, string> = {
  "android-session": "emulator-5554",
  "ios-session": "sim-1",
};

function textBlocks(result: unknown): string[] {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((block) => block.text ?? "");
}

function resumedNotices(result: unknown): Array<Record<string, unknown>> {
  return textBlocks(result)
    .map((text) => {
      try {
        return JSON.parse(text) as { warning?: Record<string, unknown> };
      } catch {
        return {};
      }
    })
    .flatMap((parsed) => (parsed.warning ? [parsed.warning] : []));
}

describe("a daemon that resumes after a stall keeps its sessions (#10989)", () => {
  let baseTimer: LivenessTimer;
  let daemonTimer: StoppableDaemonTimer;
  let sessionManager: SessionManager;
  let monitor: SessionHeartbeatMonitor;
  let reaped: Array<{ sessionId: string; reason: string }>;
  let daemonManager: FakeDaemonManager;
  let daemonInstance: string;
  let acquiredAppleSessionUuid: string;
  let heartbeatUnavailable: boolean;
  let heartbeats: Array<Record<string, unknown>>;
  let refusals: string[];
  let handovers: LivenessHandover[];
  let spies: Array<ReturnType<typeof spyOn>>;
  const proxies: DaemonMcpProxy[] = [];

  beforeAll(async () => {
    // Warm the MCP handshake and session binding outside the per-test timing budget.
    const warmManager = new FakeDaemonManager();
    warmManager.statusResult = { ...warmManager.statusResult, version: DAEMON_VERSION };
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        timer: new FakeTimer(),
        autoStartDaemon: false,
        daemonAvailabilityProbe: async () => true,
        daemonManager: warmManager,
        clientFactory: () =>
          new FakeDaemonClient({
            daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
            toolResult: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    runtime: { deviceId: "warm-device", session: { sessionUuid: "warm-session" } },
                  }),
                },
              ],
            },
          }),
      },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "warm-plain-restart", version: "1" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await client.callTool({ name: "getApple", arguments: {} });
    } finally {
      await client.close();
      await server.close();
      await proxy.close();
    }
  });

  function daemonState(): DaemonStateAccess {
    return {
      isInitialized: () => true,
      getDaemonInstance: () => daemonInstance,
      getSessionManager: () => sessionManager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        releaseDevice: async () => {},
        getStats: () => ({ total: 2, idle: 0, assigned: 2, error: 0 }),
      }),
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    } as DaemonStateAccess;
  }

  /** A daemon socket answering heartbeats with the real handler, and its ack as the result. */
  function daemonClient(): FakeDaemonClient {
    const client = new FakeDaemonClient({
      daemonMethodResults: new Map<string, unknown>([["tools/list", { tools: [] }]]),
      resourceResult: { contents: [] },
      toolResultFor: (name, params) =>
        name === "getAndroid" || name === "getApple"
          ? {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    runtime: {
                      deviceId: DEVICES[name === "getAndroid" ? "android-session" : "ios-session"],
                      session: {
                        sessionUuid:
                          name === "getAndroid" ? "android-session" : acquiredAppleSessionUuid,
                      },
                    },
                  }),
                },
              ],
            }
          : { content: [{ type: "text", text: JSON.stringify({ observed: params.sessionUuid }) }] },
    });
    const forward = client.callDaemonMethod.bind(client);
    client.callDaemonMethod = async (method, params) => {
      if (method !== "daemon/heartbeat") {
        return forward(method, params);
      }
      if (heartbeatUnavailable) {
        throw new DaemonUnavailableError("Daemon is not reachable");
      }
      return daemonTimer.whenRunning(async () => {
        heartbeats.push(params);
        const response = await handleDaemonRequest(
          { id: "heartbeat", type: "daemon_request", method, params },
          daemonState(),
        );
        if (!response.success) {
          if (typeof response.code === "string") {
            refusals.push(response.code);
          }
          throw Object.assign(new Error(response.error), response);
        }
        return response.result;
      });
    };
    return client;
  }

  function createProxy(): DaemonMcpProxy {
    const proxy = new DaemonMcpProxy({
      clientFactory: () => daemonClient(),
      daemonManager,
      autoStartDaemon: false,
      timer: baseTimer,
      idGenerator: new FakeIdGenerator(["proxy-token"]),
      heartbeatTimeoutMs: LEASE_MS,
      heartbeatIntervalMs: INTERVAL_MS,
    });
    proxy.onLivenessHandover((handover) => handovers.push(handover));
    proxies.push(proxy);
    return proxy;
  }

  /** Acquire both sessions: ios-session is the latest binding, android-session is held. */
  async function acquireBoth(proxy: DaemonMcpProxy): Promise<void> {
    await proxy.callTool("getAndroid", {});
    await proxy.callTool("getApple", {});
    await baseTimer.advanceTimeAsync(INTERVAL_MS * 2);
  }

  /** SIGSTOP for {@link STOP_MS}: the proxy hands over during it, then SIGCONT. */
  async function stopThenResume(): Promise<void> {
    daemonTimer.stop();
    await advance(STOP_MS);
    expect(handovers.map((handover) => handover.code)).toEqual(["daemon_stalled"]);
    daemonTimer.resume();
    await drainUntilQuiescent(baseTimer);
  }

  async function advance(ms: number): Promise<void> {
    await baseTimer.advanceTimeAsync(ms);
  }

  /** A dead socket lasts through all three recovery attempts, then another probe interval. */
  async function outageThroughHandover(proxy: DaemonMcpProxy): Promise<void> {
    heartbeatUnavailable = true;
    await monitor.stop();
    await settleByFakeEvents(
      baseTimer,
      new Promise<LivenessHandover>((resolve) => proxy.onLivenessHandover(resolve)),
      { description: "plain daemon outage handover" },
    );
    expect(handovers).toMatchObject([{ code: "daemon_stalled", attempts: 3 }]);
    await advance(INTERVAL_MS);
  }

  /** A replacement's real monitor starts its own owner window; no owner heartbeat is fabricated. */
  async function restartAwaitingOwner(withSessions = true): Promise<void> {
    await monitor.stop();
    sessionManager.stopCleanupTimer();
    sessionManager = new SessionManager(daemonTimer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    if (withSessions) {
      for (const [sessionId, deviceId] of Object.entries(DEVICES)) {
        const session = await sessionManager.createSession(
          sessionId,
          deviceId,
          sessionId.startsWith("ios") ? "ios" : "android",
          { timeoutMs: 60_000, heartbeatTimeoutMs: LEASE_MS },
        );
        session.ownership = "awaiting-owner";
        session.awaitingOwnerSince = baseTimer.now();
      }
    }
    monitor = new SessionHeartbeatMonitor(
      sessionManager,
      () => false,
      async (sessionId, reason) => {
        reaped.push({ sessionId, reason });
        await sessionManager.releaseSession(sessionId, reason);
      },
      { timer: daemonTimer, checkIntervalMs: INTERVAL_MS },
    );
    monitor.start();
    daemonInstance = "daemon-2";
    heartbeatUnavailable = false;
  }

  beforeEach(async () => {
    baseTimer = new LivenessTimer();
    daemonTimer = new StoppableDaemonTimer(baseTimer);
    sessionManager = new SessionManager(daemonTimer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    reaped = [];
    monitor = new SessionHeartbeatMonitor(
      sessionManager,
      () => false,
      async (sessionId, reason) => {
        reaped.push({ sessionId, reason });
        await sessionManager.releaseSession(sessionId);
      },
      { timer: daemonTimer },
    );
    monitor.start();
    daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    daemonInstance = "daemon-1";
    acquiredAppleSessionUuid = "ios-session";
    heartbeatUnavailable = false;
    heartbeats = [];
    refusals = [];
    handovers = [];
    for (const [sessionId, deviceId] of Object.entries(DEVICES)) {
      await sessionManager.createSession(
        sessionId,
        deviceId,
        sessionId.startsWith("ios") ? "ios" : "android",
        { timeoutMs: 60_000, heartbeatTimeoutMs: LEASE_MS },
      );
    }
    spies = [
      spyOn(DaemonClient, "isAvailable").mockResolvedValue(true),
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
      spyOn(logger, "debug").mockImplementation(() => {}),
    ];
  });

  afterEach(async () => {
    daemonTimer.resume();
    for (const proxy of proxies.splice(0)) {
      await proxy.close();
    }
    await monitor.stop();
    sessionManager.stopCleanupTimer();
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  test("the proxy keeps probing, resumes heartbeats as soon as the daemon answers, and nothing is reaped", async () => {
    const proxy = createProxy();
    await acquireBoth(proxy);

    await stopThenResume();
    const heartbeatsAtResume = heartbeats.length;
    // Long past the lease plus grace from the resume, which is when every session was reaped.
    await advance(LEASE_MS * 5);

    expect(reaped).toEqual([]);
    for (const sessionId of Object.keys(DEVICES)) {
      expect(sessionManager.getSession(sessionId)).toBeTruthy();
      expect(sessionManager.getSessionLeaseState(sessionId)?.phase).toBe("live");
    }
    // Both sessions are heartbeated on cadence again, with the same owner token.
    const resumed = heartbeats.slice(heartbeatsAtResume);
    expect(
      resumed.filter((params) => params.sessionId === "android-session").length,
    ).toBeGreaterThan(5);
    expect(resumed.filter((params) => params.sessionId === "ios-session").length).toBeGreaterThan(
      5,
    );
    expect(new Set(resumed.map((params) => params.livenessOwnerToken))).toEqual(
      new Set(["proxy-token"]),
    );
    // Observation only: the proxy never touched the daemon's lifecycle.
    expect(daemonManager.startCallCount).toBe(0);
    expect(daemonManager.restartCallCount).toBe(0);
    expect(handovers).toHaveLength(1);
  });

  test("the first call after the resume succeeds and carries the stall as a warning, once", async () => {
    const proxy = createProxy();
    await acquireBoth(proxy);
    await stopThenResume();
    await advance(INTERVAL_MS * 2);

    // The implicit call reaches the latest binding, restored as it was before the handover.
    const implicit = await proxy.callTool("observe", {});
    expect((implicit as { isError?: boolean }).isError).toBeFalsy();
    expect(textBlocks(implicit)[0]).toContain("ios-session");
    expect(resumedNotices(implicit)).toEqual([
      expect.objectContaining({ code: DAEMON_STALL_RESUMED_CODE, sessionUuid: "ios-session" }),
    ]);
    // The held session resumed too; the first call naming it carries its own notice.
    const first = await proxy.callTool("observe", { sessionUuid: "android-session" });
    expect((first as { isError?: boolean }).isError).toBeFalsy();
    expect(resumedNotices(first)).toEqual([
      expect.objectContaining({
        code: DAEMON_STALL_RESUMED_CODE,
        sessionUuid: "android-session",
        deviceId: "emulator-5554",
        handedOverCode: "daemon_stalled",
      }),
    ]);
    const second = await proxy.callTool("observe", { sessionUuid: "android-session" });
    expect(resumedNotices(second)).toEqual([]);
  });

  test("a call that names the session before the probe's next round resumes it itself", async () => {
    const proxy = createProxy();
    await acquireBoth(proxy);
    await stopThenResume();

    // No time passes after SIGCONT: the call, not the probe, is the first to reach the daemon.
    const result = await proxy.callTool("observe", { sessionUuid: "android-session" });

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(resumedNotices(result)).toEqual([
      expect.objectContaining({ code: DAEMON_STALL_RESUMED_CODE, sessionUuid: "android-session" }),
    ]);
    // The daemon that stalled answered the resume itself: no restart is reported (#11018).
    expect(resumedNotices(result)[0]).not.toHaveProperty("daemonInstance");
    expect(String(resumedNotices(result)[0].message)).toContain("nothing needs restarting");
    await advance(LEASE_MS * 5);
    expect(reaped).toEqual([]);
  });

  test("PIN: a plain named resume answered not-found ends immediately", async () => {
    const proxy = createProxy();
    await acquireBoth(proxy);
    daemonTimer.stop();
    await advance(STOP_MS);
    expect(handovers.map((handover) => handover.code)).toEqual(["daemon_stalled"]);
    daemonInstance = "daemon-2";
    await sessionManager.releaseSession("ios-session", "daemon-shutdown");
    daemonTimer.resume();
    await drainUntilQuiescent(baseTimer);
    expect(handovers.map((handover) => handover.code)).toEqual(["daemon_stalled"]);
    await advance(INTERVAL_MS);
    expect(proxy.getTerminalSessionRelease()).toEqual({
      sessionUuid: "ios-session",
      reason: "daemon-shutdown",
    });
    await expect(proxy.callTool("observe", { sessionUuid: "ios-session" })).rejects.toBeInstanceOf(
      DaemonBoundSessionExpiredError,
    );
    await expect(proxy.callTool("observe", { sessionUuid: "ios-session" })).rejects.toMatchObject({
      reason: "daemon-shutdown",
    });
    expect(handovers.map((handover) => handover.code)).toEqual(["daemon_stalled"]);
  });

  test("a restarted daemon is reclaimed by the probe for both plain sessions", async () => {
    const proxy = createProxy();
    await acquireBoth(proxy);
    daemonTimer.stop();
    await settleByFakeEvents(
      baseTimer,
      new Promise<LivenessHandover>((resolve) => proxy.onLivenessHandover(resolve)),
      { description: "plain stopped daemon handover" },
    );
    expect(handovers[0]?.code).toBe("daemon_stalled");
    expect(proxy.getTerminalSessionRelease()).toBeUndefined();
    // A new daemon process answers on the socket instead of the one that stalled.
    daemonInstance = "daemon-2";
    daemonTimer.resume();
    await drainUntilQuiescent(baseTimer);
    const heartbeatsAtRestart = heartbeats.length;
    await advance(LEASE_MS + SUSPECT_GRACE_MS + INTERVAL_MS * 2);

    // Each pinned probe is refused before the unpinned owner claim reclaims the session.
    expect(refusals.filter((code) => code === DAEMON_INSTANCE_CHANGED_CODE)).toHaveLength(2);
    const sinceRestart = heartbeats.slice(heartbeatsAtRestart);
    expect(
      sinceRestart.some(
        (params) =>
          params.claimLivenessOwnership === true && params.expectedDaemonInstance === undefined,
      ),
    ).toBe(true);
    expect(reaped).toEqual([]);
    for (const sessionId of Object.keys(DEVICES)) {
      expect(sessionManager.getSessionLeaseState(sessionId)?.phase).toBe("live");
    }
    expect(daemonManager.startCallCount).toBe(0);
    expect(daemonManager.restartCallCount).toBe(0);
  });

  test("plain outage reproduction: the probe reclaims awaiting-owner sessions before rehydration-owner-timeout", async () => {
    const proxy = createProxy();
    await acquireBoth(proxy);
    await outageThroughHandover(proxy);
    await restartAwaitingOwner();
    const restartedAt = baseTimer.now();
    const ownerHeartbeatBefore = sessionManager.getSession("ios-session")!.lastOwnerHeartbeat;
    await advance(INTERVAL_MS);
    expect(baseTimer.now() - restartedAt).toBeLessThan(LEASE_MS + SUSPECT_GRACE_MS);
    expect(sessionManager.getSession("ios-session")!.ownership).toBe("owned");
    expect(ownerHeartbeatBefore).toBeUndefined();
    expect(sessionManager.getSession("ios-session")!.lastOwnerHeartbeat).toBeGreaterThan(
      restartedAt,
    );
    await advance(LEASE_MS + SUSPECT_GRACE_MS + INTERVAL_MS);
    expect(reaped).toEqual([]);
    const first = await proxy.callTool("observe", {});
    expect((first as { isError?: boolean }).isError).toBeFalsy();
    expect(resumedNotices(first)).toEqual([
      expect.objectContaining({
        code: DAEMON_RESTART_RESUMED_CODE,
        sessionUuid: "ios-session",
        previousDaemonInstance: "daemon-1",
        daemonInstance: "daemon-2",
      }),
    ]);
    expect(resumedNotices(await proxy.callTool("observe", {}))).toEqual([]);
    expect(daemonManager.startCallCount).toBe(0);
    expect(daemonManager.restartCallCount).toBe(0);
  });

  test("plain restart then released: the MCP refusal is session_ownership_lost with the daemon reason", async () => {
    const proxy = createProxy();
    await acquireBoth(proxy);
    await outageThroughHandover(proxy);
    await restartAwaitingOwner();
    await sessionManager.releaseSession("ios-session", "rehydration-owner-timeout");
    await advance(INTERVAL_MS);
    expect(proxy.getTerminalSessionRelease()).toEqual({
      sessionUuid: "ios-session",
      reason: "rehydration-owner-timeout",
    });
    expect(handovers.map((handover) => handover.code)).toEqual(["daemon_stalled"]);
    const { server } = createProxyMcpServer({ proxy });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "plain-restart-loss", version: "1" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      // Discovery remains available without consuming the first implicit release report (#9997).
      const discovery = await Promise.allSettled([client.listTools(), client.listResources()]);
      expect(discovery).toEqual([
        { status: "fulfilled", value: { tools: [] } },
        { status: "fulfilled", value: { resources: [] } },
      ]);
      const implicit = await client.callTool({ name: "observe", arguments: {} });
      expect(implicit).toEqual(
        noActiveDeviceSessionResult(
          new DaemonConnectionSessionReleasedError("rehydration-owner-timeout"),
        ),
      );
      // As after a normal keeper release, the next implicit read goes through without a session.
      const nextImplicit = await client.callTool({ name: "observe", arguments: {} });
      expect(nextImplicit.isError).toBeFalsy();
      expect(JSON.parse(textBlocks(nextImplicit)[0])).toEqual({});
      const named = await client.callTool({
        name: "observe",
        arguments: { sessionUuid: "ios-session" },
      });
      expect(named.isError).toBe(true);
      expect(JSON.parse(textBlocks(named)[0]).error).toMatchObject({
        code: "session_ownership_lost",
        sessionUuid: "ios-session",
        reason: "rehydration-owner-timeout",
        recovery: { action: "acquire_replacement_session" },
      });
      acquiredAppleSessionUuid = "replacement-ios-session";
      await sessionManager.createSession(acquiredAppleSessionUuid, DEVICES["ios-session"], "ios", {
        timeoutMs: 60_000,
        heartbeatTimeoutMs: LEASE_MS,
      });
      const acquired = await client.callTool({ name: "getApple", arguments: {} });
      expect(acquired.isError).toBeFalsy();
      expect(proxy.getTerminalSessionRelease()).toBeUndefined();
      const rebound = await client.callTool({ name: "observe", arguments: {} });
      expect(rebound.isError).toBeFalsy();
      expect(JSON.parse(textBlocks(rebound)[0])).toEqual({ observed: acquiredAppleSessionUuid });
      expect(handovers.map((handover) => handover.code)).toEqual(["daemon_stalled"]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("plain restart loss permits the released bound session screenshot but fences named tools", async () => {
    const proxy = createProxy();
    await acquireBoth(proxy);
    await outageThroughHandover(proxy);
    await restartAwaitingOwner();
    await sessionManager.releaseSession("ios-session", "rehydration-owner-timeout");
    await advance(INTERVAL_MS);

    expect(proxy.getTerminalSessionRelease()).toEqual({
      sessionUuid: "ios-session",
      reason: "rehydration-owner-timeout",
    });
    await expect(
      proxy.readResource("automobile:device-session/ios-session/screenshot"),
    ).resolves.toEqual({ contents: [] });
    const named = proxy.callTool("observe", { sessionUuid: "ios-session" });
    await expect(named).rejects.toBeInstanceOf(DaemonBoundSessionExpiredError);
    await expect(named).rejects.toMatchObject({
      sessionUuid: "ios-session",
      reason: "rehydration-owner-timeout",
    });
  });

  test("plain restart losses name each lost session and preserve the one-shot implicit release", async () => {
    const proxy = createProxy();
    await acquireBoth(proxy);
    await outageThroughHandover(proxy);
    await restartAwaitingOwner();
    await sessionManager.releaseSession("android-session", "heartbeat-timeout");
    await sessionManager.releaseSession("ios-session", "rehydration-owner-timeout");
    await advance(INTERVAL_MS);

    // The held loss is its own refusal, even while another UUID is the terminal binding.
    await expect(
      proxy.callTool("observe", { sessionUuid: "android-session" }),
    ).rejects.toBeInstanceOf(DaemonBoundSessionExpiredError);
    await expect(
      proxy.callTool("observe", { sessionUuid: "android-session" }),
    ).rejects.toMatchObject({
      sessionUuid: "android-session",
      reason: "heartbeat-timeout",
    });
    // Naming the held loss does not consume the latest binding's one-shot implicit report.
    await expect(proxy.callTool("observe", {})).rejects.toBeInstanceOf(
      DaemonConnectionSessionReleasedError,
    );
    expect(JSON.parse(textBlocks(await proxy.callTool("observe", {}))[0])).toEqual({});
    await expect(proxy.callTool("observe", { sessionUuid: "ios-session" })).rejects.toBeInstanceOf(
      DaemonBoundSessionExpiredError,
    );
    await expect(proxy.callTool("observe", { sessionUuid: "ios-session" })).rejects.toMatchObject({
      sessionUuid: "ios-session",
      reason: "rehydration-owner-timeout",
    });

    // A successor offering those UUIDs again still requires an explicit reacquisition.
    await restartAwaitingOwner();
    // Reacquiring the latest UUID clears its loss and leaves no terminal binding.
    await proxy.callTool("getApple", {});
    expect(proxy.getTerminalSessionRelease()).toBeUndefined();
    expect(
      JSON.parse(textBlocks(await proxy.callTool("observe", { sessionUuid: "ios-session" }))[0]),
    ).toEqual({
      observed: "ios-session",
    });
    await expect(
      proxy.callTool("observe", { sessionUuid: "android-session" }),
    ).rejects.toMatchObject({
      name: "DaemonBoundSessionExpiredError",
      sessionUuid: "android-session",
      reason: "heartbeat-timeout",
    });
    await proxy.callTool("getAndroid", {});
    expect(
      JSON.parse(
        textBlocks(await proxy.callTool("observe", { sessionUuid: "android-session" }))[0],
      ),
    ).toEqual({
      observed: "android-session",
    });
    expect(handovers.map((handover) => handover.code)).toEqual(["daemon_stalled"]);
  });

  test("PIN: same-daemon released sessions still report proxy_stalled by the daemon", async () => {
    const proxy = createProxy();
    await acquireBoth(proxy);
    await outageThroughHandover(proxy);
    await sessionManager.releaseSession("ios-session", "heartbeat-timeout");
    heartbeatUnavailable = false;
    await advance(INTERVAL_MS);
    await expect(proxy.callTool("observe", { sessionUuid: "ios-session" })).rejects.toMatchObject({
      handover: { code: "proxy_stalled", stalledBy: "daemon", action: "reacquire_lost_sessions" },
    });
    expect(handovers.map((handover) => handover.code)).toEqual(["daemon_stalled", "proxy_stalled"]);
  });

  test("plain named restart refusal before the pinned probe reports the successor's terminal reason", async () => {
    const proxy = createProxy();
    await acquireBoth(proxy);
    await outageThroughHandover(proxy);
    await restartAwaitingOwner();
    await sessionManager.releaseSession("ios-session", "rehydration-owner-timeout");
    // No probe tick: daemonInstance in the named resume's refusal is the restart evidence.
    await expect(proxy.callTool("observe", { sessionUuid: "ios-session" })).rejects.toMatchObject({
      name: "DaemonBoundSessionExpiredError",
      reason: "rehydration-owner-timeout",
    });
    expect(proxy.getTerminalSessionRelease()).toEqual({
      sessionUuid: "ios-session",
      reason: "rehydration-owner-timeout",
    });
    expect(handovers.map((handover) => handover.code)).toEqual(["daemon_stalled"]);
  });

  test("plain reclaim awaits a reasonless not-found until the successor rehydrates", async () => {
    const proxy = createProxy();
    await acquireBoth(proxy);
    await outageThroughHandover(proxy);
    await restartAwaitingOwner(false);
    await advance(INTERVAL_MS);
    expect(proxy.getTerminalSessionRelease()).toBeUndefined();
    await restartAwaitingOwner();
    await advance(INTERVAL_MS);
    expect(resumedNotices(await proxy.callTool("observe", {}))).toMatchObject([
      { code: DAEMON_RESTART_RESUMED_CODE },
    ]);
    await advance(LEASE_MS * 3);
    expect(reaped).toEqual([]);
  });

  test("plain reclaim's reasonless not-found expires within the existing bounded window", async () => {
    const proxy = createProxy();
    await acquireBoth(proxy);
    await outageThroughHandover(proxy);
    await restartAwaitingOwner(false);
    await advance(INTERVAL_MS);
    expect(proxy.getTerminalSessionRelease()).toBeUndefined();
    await advance(RECOVERABLE_NOT_FOUND_HEARTBEAT_WINDOW_MS + INTERVAL_MS);
    expect(proxy.getTerminalSessionRelease()).toEqual({
      sessionUuid: "ios-session",
      reason: "session-not-found",
    });
    await expect(proxy.callTool("observe", {})).rejects.toMatchObject({
      reason: "session-not-found",
    });
    expect(handovers.map((handover) => handover.code)).toEqual(["daemon_stalled"]);
  });
});

afterEach(() => {
  mock.restore();
});
