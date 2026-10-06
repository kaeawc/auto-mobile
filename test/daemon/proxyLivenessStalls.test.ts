import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonMcpProxy, DaemonSessionStalledError } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import {
  LIVENESS_RECOVERY_ATTEMPTS,
  type LivenessHandover,
} from "../../src/daemon/proxyLivenessRecovery";
import { DAEMON_SESSION_SUSPECT_CODE } from "../../src/daemon/types";
import { declaresDeviceSessionSuspect } from "../../src/server/deviceSessionResult";
import { shapeToolCallError } from "../../src/server/shapeToolCallError";
import { SessionSuspectError } from "../../src/daemon/sessionManager";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";
import type { Timer } from "../../src/utils/SystemTimer";

// #10053: the proxy's two structured liveness states, against the daemon's real heartbeat
// handler and session manager, with a scripted-unresponsive daemon socket. Everything runs on a
// fake timer; nothing sleeps.

const LEASE_MS = 10_000;
const DEVICE_POOL = {
  refreshDevices: async () => 0,
  getStats: () => ({ total: 2, idle: 0, assigned: 2, error: 0 }),
};
const DEVICES: Record<string, string> = {
  "android-session": "emulator-5554",
  "ios-session": "sim-1",
};

/** A fake timer whose clock a test can push ahead without firing timers: a stalled event loop. */
class StallableTimer implements Timer {
  private skewMs = 0;
  constructor(private readonly base: FakeTimer) {}
  /** Everything reading this clock (proxy and daemon) now sees `ms` more elapsed time. */
  stall(ms: number): void {
    this.skewMs += ms;
  }
  now(): number {
    return this.base.now() + this.skewMs;
  }
  sleep(ms: number): Promise<void> {
    return this.base.sleep(ms);
  }
  setTimeout(callback: () => void, ms: number): NodeJS.Timeout {
    return this.base.setTimeout(callback, ms);
  }
  clearTimeout(handle: NodeJS.Timeout): void {
    this.base.clearTimeout(handle);
  }
  setInterval(callback: () => void, ms: number): NodeJS.Timeout {
    return this.base.setInterval(callback, ms);
  }
  clearInterval(handle: NodeJS.Timeout): void {
    this.base.clearInterval(handle);
  }
}

function daemonStateFor(sessionManager: SessionManager): DaemonStateAccess {
  return {
    isInitialized: () => true,
    getSessionManager: () => sessionManager,
    getDevicePool: () => DEVICE_POOL,
    getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
  };
}

function deviceStartResult(sessionUuid: string, deviceId: string) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ runtime: { deviceId, session: { sessionUuid } } }),
      },
    ],
  };
}

describe("proxy liveness stalls (#10053)", () => {
  let baseTimer: FakeTimer;
  let timer: StallableTimer;
  let sessionManager: SessionManager;
  let daemonManager: FakeDaemonManager;
  /** Heartbeats the scripted daemon swallows before it answers again; Infinity = never. */
  let hangHeartbeats: number;
  /** Sessions whose heartbeats the scripted daemon never answers. */
  let hangSessions: Set<string>;
  /** `observe` is refused with the daemon's suspect-session error. */
  let suspectObserve: boolean;
  let heartbeatsSeen: number;
  let handovers: LivenessHandover[];
  let infoSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;
  let isAvailableSpy: ReturnType<typeof spyOn>;
  const proxies: DaemonMcpProxy[] = [];

  function daemonBackedClient(): FakeDaemonClient {
    return new FakeDaemonClient({
      toolResultFor: (name, params) =>
        name === "getAndroid"
          ? deviceStartResult("android-session", DEVICES["android-session"])
          : name === "getApple"
            ? deviceStartResult("ios-session", DEVICES["ios-session"])
            : name === "observe" && suspectObserve
              ? shapeSuspectResult()
              : undefined,
      onCallDaemonMethod: async (method, params) => {
        if (method !== "daemon/heartbeat") {
          return;
        }
        heartbeatsSeen += 1;
        if (hangSessions.has(params.sessionId)) {
          return new Promise<void>(() => {});
        }
        if (hangHeartbeats > 0) {
          hangHeartbeats -= 1;
          return new Promise<void>(() => {});
        }
        const response = await handleDaemonRequest(
          { id: "request-1", type: "daemon_request", method, params },
          daemonStateFor(sessionManager),
        );
        if (!response.success) {
          throw Object.assign(new Error(response.error), { code: response.code });
        }
      },
    });
  }

  function shapeSuspectResult() {
    return shapeToolCallError(new SessionSuspectError("android-session", 8_000), {
      toolName: "observe",
      source: "ProxyServer",
    });
  }

  function createProxy(intervalMs: number, autoStartDaemon = false): DaemonMcpProxy {
    const proxy = new DaemonMcpProxy({
      clientFactory: () => daemonBackedClient(),
      daemonManager,
      autoStartDaemon,
      timer,
      idGenerator: new FakeIdGenerator(["proxy-token"]),
      heartbeatTimeoutMs: LEASE_MS,
      heartbeatIntervalMs: intervalMs,
    });
    proxy.onLivenessHandover((handover) => handovers.push(handover));
    proxies.push(proxy);
    return proxy;
  }

  async function acquire(proxy: DaemonMcpProxy, tool: "getAndroid" | "getApple"): Promise<void> {
    await proxy.callTool(tool, {});
  }

  /** Advance in small steps until a handover lands; returns how long that took. */
  async function advanceUntilHandover(limitMs = 40_000): Promise<number> {
    const startedAt = timer.now();
    for (let elapsed = 0; elapsed < limitMs && handovers.length === 0; elapsed += 250) {
      await baseTimer.advanceTimeAsync(250);
    }
    return timer.now() - startedAt;
  }

  beforeEach(async () => {
    baseTimer = new FakeTimer();
    timer = new StallableTimer(baseTimer);
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    hangHeartbeats = 0;
    hangSessions = new Set();
    suspectObserve = false;
    heartbeatsSeen = 0;
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
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    infoSpy = spyOn(logger, "info").mockImplementation(() => {});
    warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const proxy of proxies.splice(0)) {
      await proxy.close();
    }
    isAvailableSpy.mockRestore();
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    sessionManager.stopCleanupTimer();
  });

  describe("daemon_stalled", () => {
    test.each([2_000, 5_000])(
      "an unresponsive daemon yields daemon_stalled after exactly three failed attempts at a %i ms cadence",
      async (intervalMs) => {
        const proxy = createProxy(intervalMs);
        await acquire(proxy, "getAndroid");
        const lastAck = timer.now();
        hangHeartbeats = Number.POSITIVE_INFINITY;
        heartbeatsSeen = 0;

        const elapsedMs = await advanceUntilHandover();

        expect(handovers).toHaveLength(1);
        const [handover] = handovers;
        expect(handover.code).toBe("daemon_stalled");
        expect(handover.attempts).toBe(LIVENESS_RECOVERY_ATTEMPTS);
        // The periodic heartbeat that went unanswered plus exactly three recovery attempts.
        expect(heartbeatsSeen).toBe(1 + LIVENESS_RECOVERY_ATTEMPTS);
        // All of it fits inside the lease plus the suspect grace window.
        expect(elapsedMs).toBeLessThan(LEASE_MS + SUSPECT_GRACE_MS);
        expect(handover.sessions).toEqual([
          {
            sessionUuid: "android-session",
            deviceId: "emulator-5554",
            lastAcknowledgedHeartbeatAt: lastAck,
          },
        ]);
        expect(handover.lastAcknowledgedHeartbeatAt).toBe(lastAck);
        expect(handover.action).toBe("restart_daemon_then_resume_by_session_uuid");
        // The proxy never touched daemon lifecycle.
        expect(daemonManager.startCallCount).toBe(0);
        expect(daemonManager.restartCallCount).toBe(0);
        expect(daemonManager.recoverControlStateCallCount).toBe(0);
      },
    );

    test("the next tool call for the session returns the structured error, and so does a sessionless one", async () => {
      const proxy = createProxy(2_000);
      await acquire(proxy, "getAndroid");
      hangHeartbeats = Number.POSITIVE_INFINITY;
      await advanceUntilHandover();

      const error = await proxy.callTool("observe", { sessionUuid: "android-session" }).then(
        () => undefined,
        (rejected: unknown) => rejected,
      );
      expect(error).toBeInstanceOf(DaemonSessionStalledError);
      const stalled = error as DaemonSessionStalledError;
      expect(stalled.toPayload().error).toMatchObject({
        code: "daemon_stalled",
        attempts: 3,
        sessions: [{ sessionUuid: "android-session", deviceId: "emulator-5554" }],
        recovery: { action: "restart_daemon_then_resume_by_session_uuid" },
      });

      // The sessionless call reaches the same fenced binding and gets the same error.
      await expect(proxy.callTool("observe", {})).rejects.toMatchObject({
        reason: "daemon_stalled",
        handover: { code: "daemon_stalled" },
      });
    });

    test("an idle harness is told through the handover listener without making a call", async () => {
      const proxy = createProxy(2_000);
      await acquire(proxy, "getAndroid");
      hangHeartbeats = Number.POSITIVE_INFINITY;
      await advanceUntilHandover();

      expect(handovers).toHaveLength(1);
      expect(handovers[0].sessions.map((session) => session.sessionUuid)).toEqual([
        "android-session",
      ]);
    });

    test.each([1, 2, 3])(
      "a daemon that answers recovery attempt %i leaves the session usable with nothing surfaced",
      async (answersAtAttempt) => {
        const proxy = createProxy(2_000);
        await acquire(proxy, "getAndroid");
        // The periodic heartbeat plus the attempts before the answering one all go unanswered.
        hangHeartbeats = answersAtAttempt;
        heartbeatsSeen = 0;

        await baseTimer.advanceTimeAsync(LEASE_MS + SUSPECT_GRACE_MS);

        expect(handovers).toEqual([]);
        await expect(
          proxy.callTool("observe", { sessionUuid: "android-session" }),
        ).resolves.toBeDefined();
        expect(sessionManager.getSession("android-session")).toBeTruthy();
        expect(
          infoSpy.mock.calls.some(([message]) =>
            String(message).includes(`Recovered daemon_stalled for session android-session`),
          ),
        ).toBe(true);
      },
    );

    test("recovery never starts or restarts the daemon even when auto-start is on and the daemon is down", async () => {
      const proxy = createProxy(2_000, true);
      await acquire(proxy, "getAndroid");
      hangHeartbeats = Number.POSITIVE_INFINITY;
      // Reconnect attempts see no daemon at all.
      isAvailableSpy.mockResolvedValue(false);
      const refused = spyOn(DaemonClient, "isAvailable").mockResolvedValue(false);

      try {
        const baselineStarts = daemonManager.startCallCount;
        await advanceUntilHandover();

        expect(handovers).toHaveLength(1);
        expect(daemonManager.startCallCount).toBe(baselineStarts);
        expect(daemonManager.restartCallCount).toBe(0);
      } finally {
        refused.mockRestore();
      }
    });

    test("a held session that stalls is reported when it is named, while the latest binding keeps working", async () => {
      const proxy = createProxy(2_000);
      await acquire(proxy, "getAndroid");
      await acquire(proxy, "getApple");
      // android-session is now held and ios-session is the latest binding. Only the held one loses
      // its acknowledgements.
      hangSessions.add("android-session");
      await advanceUntilHandover();

      expect(handovers).toHaveLength(1);
      expect(handovers[0].sessions).toEqual([
        expect.objectContaining({ sessionUuid: "android-session", deviceId: "emulator-5554" }),
      ]);
      await expect(
        proxy.callTool("observe", { sessionUuid: "android-session" }),
      ).rejects.toBeInstanceOf(DaemonSessionStalledError);
      // The latest binding was never affected: it is neither fenced nor handed over.
      await expect(proxy.callTool("observe", {})).resolves.toBeDefined();
      await expect(
        proxy.callTool("observe", { sessionUuid: "ios-session" }),
      ).resolves.toBeDefined();
    });

    test("after the handover, naming the session again resumes it by UUID", async () => {
      const proxy = createProxy(2_000);
      await acquire(proxy, "getAndroid");
      hangHeartbeats = Number.POSITIVE_INFINITY;
      await advanceUntilHandover();
      await expect(
        proxy.callTool("observe", { sessionUuid: "android-session" }),
      ).rejects.toBeInstanceOf(DaemonSessionStalledError);

      // The harness restarted the daemon (the scripted daemon answers again) and names the session.
      hangHeartbeats = 0;
      await expect(
        proxy.callTool("observe", { sessionUuid: "android-session" }),
      ).resolves.toBeDefined();
      handovers.length = 0;
      await baseTimer.advanceTimeAsync(LEASE_MS * 3);
      expect(handovers).toEqual([]);
      expect(sessionManager.getSession("android-session")).toBeTruthy();
      expect(sessionManager.getSessionLeaseState("android-session")?.phase).toBe("live");
    });
  });

  describe("proxy_stalled", () => {
    test("a tick delayed past the lease but inside the grace window restores the same UUID", async () => {
      const proxy = createProxy(2_000);
      await acquire(proxy, "getAndroid");

      timer.stall(LEASE_MS + 3_000);
      expect(sessionManager.getSessionLeaseState("android-session")?.phase).toBe("suspect");
      await baseTimer.advanceTimeAsync(2_000);
      await baseTimer.advanceTimeAsync(2_000);

      expect(handovers).toEqual([]);
      expect(sessionManager.getSession("android-session")?.sessionId).toBe("android-session");
      expect(sessionManager.getSessionLeaseState("android-session")?.phase).toBe("live");
      expect(
        infoSpy.mock.calls.some(([message]) =>
          String(message).includes(
            "Recovered proxy_stalled for session android-session after 1 attempt(s); the daemon held it as suspect and kept the same UUID",
          ),
        ),
      ).toBe(true);
      await expect(
        proxy.callTool("observe", { sessionUuid: "android-session" }),
      ).resolves.toBeDefined();
    });

    test("a tick delayed past lease plus grace produces proxy_stalled naming the lost sessions and devices", async () => {
      const proxy = createProxy(2_000);
      await acquire(proxy, "getAndroid");
      await acquire(proxy, "getApple");
      const lastAck = timer.now();

      timer.stall(LEASE_MS + SUSPECT_GRACE_MS + 5_000);
      // The daemon released both sessions while the proxy could not heartbeat.
      await sessionManager.releaseSession("android-session", "heartbeat-timeout");
      await sessionManager.releaseSession("ios-session", "heartbeat-timeout");
      await baseTimer.advanceTimeAsync(2_000);
      await baseTimer.advanceTimeAsync(2_000);

      expect(handovers).toHaveLength(1);
      const [handover] = handovers;
      expect(handover.code).toBe("proxy_stalled");
      expect(handover.action).toBe("reacquire_lost_sessions");
      expect(
        handover.sessions
          .map((session) => [session.sessionUuid, session.deviceId])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      ).toEqual([
        ["android-session", "emulator-5554"],
        ["ios-session", "sim-1"],
      ]);
      expect(handover.sessions.every((s) => s.lastAcknowledgedHeartbeatAt === lastAck)).toBe(true);
      expect(daemonManager.restartCallCount).toBe(0);

      const error = await proxy.callTool("observe", { sessionUuid: "android-session" }).then(
        () => undefined,
        (rejected: unknown) => rejected,
      );
      expect(error).toBeInstanceOf(DaemonSessionStalledError);
      expect((error as DaemonSessionStalledError).toPayload().error).toMatchObject({
        code: "proxy_stalled",
        recovery: { action: "reacquire_lost_sessions" },
      });
    });

    test("a tick that is merely slow, not late by more than the lease, starts no recovery", async () => {
      const proxy = createProxy(2_000);
      await acquire(proxy, "getAndroid");

      timer.stall(LEASE_MS - 2_500);
      await baseTimer.advanceTimeAsync(2_000);
      await baseTimer.advanceTimeAsync(2_000);

      expect(handovers).toEqual([]);
      expect(
        warnSpy.mock.calls.some(([message]) => String(message).includes("tick fired more than")),
      ).toBe(false);
    });
  });

  describe("suspect refusal from the daemon", () => {
    test("a tool result naming the suspect code is recognised and starts an immediate re-heartbeat", async () => {
      const result = shapeSuspectResult();
      expect(declaresDeviceSessionSuspect(result)).toBe(true);
      expect(JSON.parse(result.content[0].text).error).toMatchObject({
        code: DAEMON_SESSION_SUSPECT_CODE,
        sessionUuid: "android-session",
        remainingMs: 8_000,
      });
      // Ordinary tool failures and prose stay unrecognised.
      expect(
        declaresDeviceSessionSuspect({
          isError: true,
          content: [{ type: "text", text: "Error: boom" }],
        }),
      ).toBe(false);
      expect(declaresDeviceSessionSuspect({ content: [{ type: "text", text: "{}" }] })).toBe(false);
    });

    test("the proxy re-heartbeats at once a session the daemon refuses as suspect and fails nothing itself", async () => {
      const proxy = createProxy(5_000);
      await acquire(proxy, "getAndroid");
      heartbeatsSeen = 0;
      suspectObserve = true;

      const result = await proxy.callTool("observe", { sessionUuid: "android-session" });
      for (let turn = 0; turn < 5; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      // The daemon's refusal reaches the harness unchanged; recovery is the proxy's own business.
      expect(result.isError).toBe(true);
      expect(declaresDeviceSessionSuspect(result)).toBe(true);
      expect(heartbeatsSeen).toBeGreaterThanOrEqual(1);
      expect(
        infoSpy.mock.calls.some(([message]) =>
          String(message).includes(
            "Recovered daemon_stalled for session android-session after 1 attempt(s)",
          ),
        ),
      ).toBe(true);
      expect(handovers).toEqual([]);
    });
  });
});
