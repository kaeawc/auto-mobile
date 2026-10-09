import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { SessionManager } from "../../src/daemon/sessionManager";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import {
  DAEMON_STALL_RESUMED_CODE,
  type LivenessHandover,
} from "../../src/daemon/proxyLivenessRecovery";
import { DAEMON_INSTANCE_CHANGED_CODE } from "../../src/daemon/types";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";
import { logger } from "../../src/utils/logger";
import type { Timer } from "../../src/utils/SystemTimer";

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
  let heartbeats: Array<Record<string, unknown>>;
  let refusals: string[];
  let handovers: LivenessHandover[];
  let spies: Array<ReturnType<typeof spyOn>>;
  const proxies: DaemonMcpProxy[] = [];

  function daemonState(): DaemonStateAccess {
    return {
      isInitialized: () => true,
      getDaemonInstance: () => daemonInstance,
      getSessionManager: () => sessionManager,
      getDevicePool: () => ({
        refreshDevices: async () => 0,
        getStats: () => ({ total: 2, idle: 0, assigned: 2, error: 0 }),
      }),
      getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
    } as DaemonStateAccess;
  }

  /** A daemon socket answering heartbeats with the real handler, and its ack as the result. */
  function daemonClient(): FakeDaemonClient {
    const client = new FakeDaemonClient({
      daemonMethodResults: new Map<string, unknown>([["tools/list", { tools: [] }]]),
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
                        sessionUuid: name === "getAndroid" ? "android-session" : "ios-session",
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
          throw Object.assign(new Error(response.error), { code: response.code });
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
    for (let elapsed = 0; elapsed < STOP_MS; elapsed += 250) {
      await baseTimer.advanceTimeAsync(250);
    }
    expect(handovers.map((handover) => handover.code)).toEqual(["daemon_stalled"]);
    daemonTimer.resume();
    await drainUntilQuiescent(baseTimer);
  }

  async function advance(ms: number): Promise<void> {
    for (let elapsed = 0; elapsed < ms; elapsed += 250) {
      await baseTimer.advanceTimeAsync(250);
    }
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
      daemonTimer,
    );
    monitor.start();
    daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    daemonInstance = "daemon-1";
    heartbeats = [];
    refusals = [];
    handovers = [];
    for (const [sessionId, deviceId] of Object.entries(DEVICES)) {
      await sessionManager.createSession(
        sessionId,
        deviceId,
        sessionId.startsWith("ios") ? "ios" : "android",
        60_000,
        LEASE_MS,
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

  test("a restarted daemon is not adopted by the probe: the handover stands, as before", async () => {
    const proxy = createProxy();
    await acquireBoth(proxy);
    daemonTimer.stop();
    for (let elapsed = 0; elapsed < STOP_MS && handovers.length === 0; elapsed += 250) {
      await baseTimer.advanceTimeAsync(250);
    }
    // A new daemon process answers on the socket instead of the one that stalled.
    daemonInstance = "daemon-2";
    daemonTimer.resume();
    await drainUntilQuiescent(baseTimer);
    const heartbeatsAtRestart = heartbeats.length;
    await advance(LEASE_MS * 5);

    // One pinned probe per session was refused, changing nothing, and probing stopped.
    expect(refusals.filter((code) => code === DAEMON_INSTANCE_CHANGED_CODE)).toHaveLength(2);
    const sinceRestart = heartbeats.slice(heartbeatsAtRestart);
    expect(sinceRestart.every((params) => params.expectedDaemonInstance === "daemon-1")).toBe(true);
    expect(sinceRestart.length).toBeLessThanOrEqual(2);
    // Nothing kept the sessions alive: the daemon releases them, exactly as it did before.
    expect(reaped.map((entry) => entry.reason)).toEqual(["heartbeat-timeout", "heartbeat-timeout"]);
    expect(daemonManager.startCallCount).toBe(0);
    expect(daemonManager.restartCallCount).toBe(0);
  });
});
