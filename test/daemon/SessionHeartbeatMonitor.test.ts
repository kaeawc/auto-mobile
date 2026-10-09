import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager } from "../../src/daemon/sessionManager";
import { SUSPECT_GRACE_MS } from "../../src/daemon/livenessOwnerLease";
import {
  DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
  DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
} from "../../src/daemon/sessionLivenessWindows";
import { DevicePool } from "../../src/daemon/devicePool";
import { ExecutionTracker } from "../../src/server/executionTracker";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";

const AUTOLOCK_ENV_KEYS = [
  "AUTOMOBILE_DEVICE_POOL_AUTOLOCK",
  "AUTO_MOBILE_DEVICE_POOL_AUTOLOCK",
  "AUTOMOBILE_DEVICE_POOL_TIMEOUT",
  "AUTO_MOBILE_DEVICE_POOL_TIMEOUT",
  "AUTOMOBILE_SESSION_HEARTBEAT_CHECK_INTERVAL_MS",
  "AUTO_MOBILE_SESSION_HEARTBEAT_CHECK_INTERVAL_MS",
  "AUTOMOBILE_SESSION_HEARTBEAT_INITIAL_GRACE_MS",
  "AUTO_MOBILE_SESSION_HEARTBEAT_INITIAL_GRACE_MS",
  "AUTOMOBILE_SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS",
  "AUTO_MOBILE_SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS",
  "AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS",
  "AUTO_MOBILE_SESSION_HEARTBEAT_TIMEOUT_MS",
] as const;

function clearAutolockEnv(): void {
  for (const key of AUTOLOCK_ENV_KEYS) {
    delete process.env[key];
  }
}

describe("SessionHeartbeatMonitor", () => {
  let timer: FakeTimer;
  let sessionManager: SessionManager;
  let savedEnv: Array<[string, string | undefined]>;

  beforeEach(() => {
    savedEnv = AUTOLOCK_ENV_KEYS.map((key) => [key, process.env[key]]);
    clearAutolockEnv();
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
  });

  afterEach(() => {
    sessionManager.stopCleanupTimer();
    clearAutolockEnv();
    for (const [key, value] of savedEnv) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
  });

  describe("scheduling", () => {
    it("start registers an interval and stop clears it", () => {
      const before = timer.getPendingIntervalCount();
      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        () => false,
        async () => {},
        timer,
      );

      monitor.start();
      expect(timer.getPendingIntervalCount()).toBe(before + 1);

      // Idempotent start
      monitor.start();
      expect(timer.getPendingIntervalCount()).toBe(before + 1);

      monitor.stop();
      expect(timer.getPendingIntervalCount()).toBe(before);
    });

    it("reaps on each interval tick", async () => {
      await sessionManager.createSession("s1", "emulator-5554", "android", 60_000);
      const reaped: string[] = [];
      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        () => false,
        async (sid) => {
          reaped.push(sid);
        },
        timer,
      );
      monitor.start();

      // Past the 5 s pre-first-heartbeat grace on the third 2 s scan: reaped once.
      for (let scan = 0; scan < 3; scan++) {
        timer.advanceTime(DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS);
        await drainMicrotasks(10);
      }
      expect(reaped).toEqual(["s1"]);

      monitor.stop();
    });

    it("a release still tearing down does not hold up other sessions' scans", async () => {
      await sessionManager.createSession("slow", "emulator-5554", "android", 60_000, 1_000);
      sessionManager.recordHeartbeat("slow");
      await sessionManager.createSession("later", "emulator-5556", "android", 60_000, 1_000);
      const reaped: Array<{ sessionId: string; at: number }> = [];
      const slowTeardown = Promise.withResolvers<void>();
      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        () => false,
        async (sessionId) => {
          reaped.push({ sessionId, at: timer.now() });
          if (sessionId === "slow") {
            await slowTeardown.promise;
          }
        },
        timer,
      );
      monitor.start();
      // "slow" lapses first; its teardown never finishes during this test.
      timer.advanceTime(1_000 + SUSPECT_GRACE_MS + DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS);
      await drainMicrotasks(10);
      expect(reaped.map((r) => r.sessionId)).toEqual(["slow"]);

      // "later" heartbeats now and lapses while "slow" is still tearing down.
      sessionManager.recordHeartbeat("later");
      const lapsesAt = timer.now() + 1_000 + SUSPECT_GRACE_MS;
      timer.advanceTime(1_000 + SUSPECT_GRACE_MS + DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS);
      await drainMicrotasks(10);

      // Released on schedule, and "slow" is not released a second time meanwhile.
      expect(reaped.map((r) => r.sessionId)).toEqual(["slow", "later"]);
      expect(reaped[1]!.at - lapsesAt).toBeLessThanOrEqual(
        DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS,
      );
      slowTeardown.resolve();
      await monitor.stop();
    });
  });

  describe("tick reaping decision", () => {
    it("reaps a heartbeating default session only after the default timeout boundary", async () => {
      await sessionManager.createSession("s1", "emulator-5554", "android", 60_000);
      sessionManager.recordHeartbeat("s1");
      const reaped: Array<{ sessionId: string; reason: string }> = [];
      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        () => false,
        async (sessionId, reason) => {
          reaped.push({ sessionId, reason });
        },
        timer,
      );

      timer.advanceTime(SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS);
      await monitor.tick();
      expect(reaped).toEqual([]);

      // Past the lease the session is suspect (#10051): held, not reaped.
      timer.advanceTime(1);
      await monitor.tick();
      expect(reaped).toEqual([]);

      timer.advanceTime(SUSPECT_GRACE_MS - 1);
      await monitor.tick();
      expect(reaped).toEqual([]);

      timer.advanceTime(1);
      await monitor.tick();
      expect(reaped).toEqual([{ sessionId: "s1", reason: "heartbeat-timeout" }]);
    });

    it("moves the default-source session boundary with the heartbeat timeout environment override", async () => {
      const timeoutMs = SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS * 2;
      process.env.AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS = String(timeoutMs);
      const session = await sessionManager.createSession("s1", "emulator-5554", "android", 60_000);
      expect(session.heartbeatTimeoutSource).toBe("default");
      expect(session.heartbeatTimeoutMs).toBe(timeoutMs);
      sessionManager.recordHeartbeat("s1");
      const reaped: Array<{ sessionId: string; reason: string }> = [];
      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        () => false,
        async (sessionId, reason) => {
          reaped.push({ sessionId, reason });
        },
        timer,
      );

      timer.advanceTime(SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS + 1);
      await monitor.tick();
      expect(reaped).toEqual([]);

      timer.advanceTime(timeoutMs - SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS - 1);
      await monitor.tick();
      expect(reaped).toEqual([]);

      // The lease ends at `timeoutMs`; the grace window then runs to +SUSPECT_GRACE_MS.
      timer.advanceTime(1);
      await monitor.tick();
      expect(reaped).toEqual([]);

      timer.advanceTime(SUSPECT_GRACE_MS);
      await monitor.tick();
      expect(reaped).toEqual([{ sessionId: "s1", reason: "heartbeat-timeout" }]);
    });

    it("uses a rehydrated session's own timeout while it awaits its owner", async () => {
      await sessionManager.createSession(
        "rehydrated-session",
        "emulator-5554",
        "android",
        60_000,
        30_000,
        undefined,
        undefined,
        "awaiting-owner",
      );
      const reaped: Array<{ sessionId: string; reason: string }> = [];
      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        () => false,
        async (sessionId, reason) => {
          reaped.push({ sessionId, reason });
        },
        timer,
      );

      // The owner gets its own lease plus the suspect grace to come back.
      timer.advanceTime(30_000 + SUSPECT_GRACE_MS);
      await monitor.tick();
      expect(reaped).toEqual([]);

      timer.advanceTime(1);
      await monitor.tick();
      expect(reaped).toEqual([
        { sessionId: "rehydrated-session", reason: "rehydration-owner-timeout" },
      ]);
    });

    it("does not apply pre-first-heartbeat grace while a default-timeout session awaits its owner", async () => {
      await sessionManager.createSession(
        "default-timeout-awaiting-owner",
        "emulator-5554",
        "android",
        60_000,
        undefined,
        undefined,
        undefined,
        "awaiting-owner",
      );
      const reaped: Array<{ sessionId: string; reason: string }> = [];
      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        () => false,
        async (sessionId, reason) => {
          reaped.push({ sessionId, reason });
        },
        timer,
      );

      // Judged only on the owner window (the default lease plus the suspect grace), never the 5 s
      // pre-first-heartbeat grace: kept through the window, reaped just after it.
      timer.advanceTime(DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS + SUSPECT_GRACE_MS - 1);
      await monitor.tick();
      expect(reaped).toEqual([]);

      timer.advanceTime(1);
      await monitor.tick();
      expect(reaped).toEqual([]);

      timer.advanceTime(1);
      await monitor.tick();
      expect(reaped).toEqual([
        { sessionId: "default-timeout-awaiting-owner", reason: "rehydration-owner-timeout" },
      ]);
    });

    it("does not reap a default-heartbeat session still within the pre-first-heartbeat grace period", async () => {
      await sessionManager.createSession("s1", "emulator-5554", "android", 60_000);
      const reaped: string[] = [];
      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        () => false,
        async (sid) => {
          reaped.push(sid);
        },
        timer,
      );

      timer.advanceTime(5_000);
      await monitor.tick();

      expect(reaped).toEqual([]);
    });

    it("reaps a default-heartbeat session shortly after it misses the first heartbeat", async () => {
      await sessionManager.createSession("s1", "emulator-5554", "android", 60_000);
      const reaped: Array<{ sessionId: string; reason: string }> = [];
      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        () => false,
        async (sessionId, reason) => {
          reaped.push({ sessionId, reason });
        },
        timer,
      );

      timer.advanceTime(5_001);
      await monitor.tick();

      expect(reaped).toEqual([{ sessionId: "s1", reason: "missing-first-heartbeat" }]);
    });

    it("reports heartbeat-timeout after a session received its first heartbeat", async () => {
      await sessionManager.createSession("s1", "emulator-5554", "android", 60_000, 1_000);
      sessionManager.recordHeartbeat("s1");
      const reaped: Array<{ sessionId: string; reason: string }> = [];
      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        () => false,
        async (sessionId, reason) => {
          reaped.push({ sessionId, reason });
        },
        timer,
      );

      timer.advanceTime(1_001 + SUSPECT_GRACE_MS);
      await monitor.tick();

      expect(reaped).toEqual([{ sessionId: "s1", reason: "heartbeat-timeout" }]);
    });

    it("does not reap a default-heartbeat session with recent activity before its first heartbeat", async () => {
      await sessionManager.createSession("s1", "emulator-5554", "android", 60_000);
      const reaped: string[] = [];
      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        () => false,
        async (sid) => {
          reaped.push(sid);
        },
        timer,
      );

      timer.advanceTime(4_000);
      await sessionManager.getOrCreateSession("s1");
      timer.advanceTime(2_000);
      await monitor.tick();
      expect(reaped).toEqual([]);

      timer.advanceTime(3_001);
      await monitor.tick();
      expect(reaped).toEqual(["s1"]);
    });

    it("skips a session with active executions", async () => {
      await sessionManager.createSession("s1", "emulator-5554", "android", 60_000);
      const reaped: string[] = [];
      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        () => true,
        async (sid) => {
          reaped.push(sid);
        },
        timer,
      );

      timer.advanceTime(5_001);
      await monitor.tick();

      expect(reaped).toEqual([]);
    });

    it("respects the session's heartbeat timeout (aligned to the idle timeout)", async () => {
      // heartbeatTimeoutMs = 60s, so a quiet session is not reaped at 31s...
      await sessionManager.createSession("s1", "emulator-5554", "android", 60_000, 60_000);
      const reaped: string[] = [];
      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        () => false,
        async (sid) => {
          reaped.push(sid);
        },
        timer,
      );

      timer.advanceTime(31_000);
      await monitor.tick();
      expect(reaped).toEqual([]);
    });

    it("treats explicit heartbeat timeout as custom even when it equals the configured default", async () => {
      process.env.AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS = "60000";
      await sessionManager.createSession("default-session", "emulator-5554", "android", 60_000);
      await sessionManager.createSession(
        "custom-session",
        "emulator-5556",
        "android",
        60_000,
        60_000,
      );
      const reaped: string[] = [];
      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        () => false,
        async (sid) => {
          reaped.push(sid);
        },
        timer,
      );

      timer.advanceTime(5_001);
      await monitor.tick();
      expect(reaped).toEqual(["default-session"]);

      timer.advanceTime(25_999);
      await monitor.tick();
      expect(reaped).not.toContain("custom-session");
    });

    it("uses the configured pre-first-heartbeat grace for default-heartbeat sessions", async () => {
      await sessionManager.createSession("s1", "emulator-5554", "android", 60_000);
      const reaped: string[] = [];
      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        () => false,
        async (sid) => {
          reaped.push(sid);
        },
        timer,
        { preFirstHeartbeatGraceMs: 1_000 },
      );

      timer.advanceTime(1_001);
      await monitor.tick();

      expect(reaped).toEqual(["s1"]);
    });

    it("honors environment overrides for the heartbeat monitor timings", async () => {
      process.env.AUTOMOBILE_SESSION_HEARTBEAT_CHECK_INTERVAL_MS = "1";
      process.env.AUTOMOBILE_SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS = "2";
      await sessionManager.createSession("s1", "emulator-5554", "android", 60_000);
      const reaped: string[] = [];
      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        () => false,
        async (sid) => {
          reaped.push(sid);
        },
        timer,
      );

      monitor.start();
      timer.advanceTime(1);
      await Promise.resolve();
      expect(reaped).toEqual([]);

      // FakeTimer catches up interval callbacks synchronously. Drive each
      // scheduled epoch separately so a completed async tick gets its normal
      // event-loop turn before the next interval callback.
      timer.advanceTime(1);
      await Promise.resolve();
      timer.advanceTime(1);
      await Promise.resolve();
      expect(reaped).toEqual(["s1"]);
      monitor.stop();
    });

    it("does not overlap a heartbeat reap with the next interval tick", async () => {
      await sessionManager.createSession("s1", "emulator-5554", "android", 60_000);
      let resolveReap!: () => void;
      const blockedReap = new Promise<void>((resolve) => {
        resolveReap = resolve;
      });
      let reapCount = 0;
      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        () => false,
        async () => {
          reapCount++;
          return blockedReap;
        },
        timer,
        { checkIntervalMs: 1, preFirstHeartbeatGraceMs: 0 },
      );

      monitor.start();
      timer.advanceTime(1);
      expect(reapCount).toBe(1);

      timer.advanceTime(1);
      expect(reapCount).toBe(1);

      resolveReap();
      await new Promise<void>((resolve) => setImmediate(resolve));
      timer.advanceTime(1);
      expect(reapCount).toBe(2);

      await monitor.stop();
    });

    it("samples the clock for each staleness decision", async () => {
      await sessionManager.createSession("stale", "emulator-5554", "android", 60_000, 100);
      sessionManager.recordHeartbeat("stale");
      timer.advanceTime(50);
      await sessionManager.createSession("newly-stale", "emulator-5556", "android", 60_000, 100);
      sessionManager.recordHeartbeat("newly-stale");
      timer.advanceTime(51 + SUSPECT_GRACE_MS);
      const reaped: string[] = [];
      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        () => false,
        async (sid) => {
          reaped.push(sid);
          if (sid === "stale") {
            timer.advanceTime(50);
          }
        },
        timer,
      );

      await monitor.tick();
      expect(reaped).toEqual(["stale", "newly-stale"]);
    });

    it("finishes other stale reaps before reporting a failed reap", async () => {
      await sessionManager.createSession("bad", "emulator-5554", "android", 60_000);
      await sessionManager.createSession("slow", "emulator-5556", "android", 60_000);
      timer.advanceTime(5_001);
      const reaped: string[] = [];
      const finishSlow = Promise.withResolvers<void>();
      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        () => false,
        async (sid) => {
          reaped.push(sid);
          if (sid === "bad") {
            throw new Error("release failed");
          }
          await finishSlow.promise;
        },
        timer,
      );

      const tick = monitor.tick();
      await Promise.resolve();
      expect(reaped).toEqual(["bad", "slow"]);
      finishSlow.resolve();
      await expect(tick).rejects.toThrow("release failed");
    });

    it("continues reaping after a synchronous reap failure", async () => {
      await sessionManager.createSession("bad", "emulator-5554", "android", 60_000);
      await sessionManager.createSession("good", "emulator-5556", "android", 60_000);
      timer.advanceTime(5_001);
      const reaped: string[] = [];
      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        () => false,
        (sid) => {
          reaped.push(sid);
          if (sid === "bad") {
            throw new Error("synchronous release failure");
          }
          return Promise.resolve();
        },
        timer,
      );

      await expect(monitor.tick()).rejects.toThrow("synchronous release failure");
      expect(reaped).toEqual(["bad", "good"]);
    });
  });

  describe("integration with DevicePool autolock", () => {
    let pool: DevicePool;

    beforeEach(async () => {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
      process.env.AUTOMOBILE_DEVICE_POOL_TIMEOUT = "60"; // 60s idle timeout
      const fakeDeviceUtils = new FakeDeviceUtils();
      const androidDevices = [
        { name: "Pixel 7", platform: "android" as const, deviceId: "emulator-5554" },
        { name: "Pixel 8", platform: "android" as const, deviceId: "emulator-5556" },
      ];
      fakeDeviceUtils.setBootedDevices("android", androidDevices);
      pool = new DevicePool(
        createDevicePoolDependencies(sessionManager, "daemon-test", {
          timer: timer,
          deviceManager: fakeDeviceUtils,
        }),
      );
      await pool.initializeWithDevices(androidDevices);
    });

    // Mirrors daemon.ts cancelAndReleaseSession (minus execution cancellation).
    const reapVia =
      (mgr: SessionManager, devicePool: DevicePool) =>
      async (sid: string): Promise<void> => {
        const deviceId = await mgr.releaseSession(sid);
        if (deviceId) {
          await devicePool.releaseDevice(deviceId, sid);
        }
      };

    it("releases an idle autolocked device promptly after the idle timeout", async () => {
      const sessionId = await pool.autolockDevice("emulator-5554", "android");
      expect(pool.getDevice("emulator-5554")!.status).toBe("busy");

      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        () => false,
        reapVia(sessionManager, pool),
        timer,
      );

      // The owner's proxy keeps heartbeating (liveness only, #10729): well within the 60s
      // idle window the device stays locked.
      const heartbeatThenTick = async (ms: number): Promise<void> => {
        for (let elapsed = 0; elapsed < ms && sessionManager.getSession(sessionId!);) {
          timer.advanceTime(2_000);
          elapsed += 2_000;
          sessionManager.recordHeartbeat(sessionId!);
          await monitor.tick();
        }
      };
      await heartbeatThenTick(30_000);
      expect(pool.getDevice("emulator-5554")!.status).toBe("busy");

      // Past the idle window (plus the suspect grace a heartbeating session earns) with no
      // tool activity: swept and released on a monitor tick (monitor interval granularity),
      // not the 5-minute cleanup sweep.
      await heartbeatThenTick(40_000);
      await sessionManager.waitForSessionRelease(sessionId!);

      const device = pool.getDevice("emulator-5554")!;
      expect(device.status).toBe("idle");
      expect(device.autolockSessionId).toBeUndefined();
      expect(sessionManager.getSession(sessionId!)).toBeNull();
    });

    it("keeps the device locked while it is being actively used", async () => {
      const sessionId = await pool.autolockDevice("emulator-5554", "android");
      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        () => false,
        reapVia(sessionManager, pool),
        timer,
      );

      // Interact every 40s (exceeds old 10s window, within 60s idle window).
      for (let i = 0; i < 5; i++) {
        timer.advanceTime(40_000);
        await sessionManager.getOrCreateSession(sessionId!); // bumps lastHeartbeat
        await monitor.tick();
        expect(pool.getDevice("emulator-5554")!.status).toBe("busy");
      }
    });

    it("keeps the autolock resolved by an implicit execution after its MCP session remaps", async () => {
      const firstSessionId = await pool.autolockDevice("emulator-5554", "android", "mcp-session-1");
      const executionTracker = new ExecutionTracker(timer);
      const hasActiveExecutions = (sessionUuid: string): boolean =>
        executionTracker.hasActiveSessionUuidExecutions(sessionUuid) ||
        executionTracker.hasActiveAutolockSessionExecutions(sessionUuid);
      sessionManager.setActiveSessionExecutionChecker(hasActiveExecutions);
      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        hasActiveExecutions,
        reapVia(sessionManager, pool),
        timer,
      );
      const execution = executionTracker.startExecution("tapOn", "mcp-session-1");
      executionTracker.setResolvedAutolockSessionUuid(execution.id, firstSessionId!);

      // A later startDevice call from the same MCP session changes only the
      // routing map. It must not transfer this running call's ownership.
      const replacementSessionId = await pool.autolockDevice(
        "emulator-5556",
        "android",
        "mcp-session-1",
      );

      timer.advanceTime(60_001); // Past the autolock idle timeout.
      await monitor.tick();

      expect(pool.getDevice("emulator-5554")!.autolockSessionId).toBe(firstSessionId);
      expect(pool.getDevice("emulator-5554")!.status).toBe("busy");
      expect(sessionManager.getSession(firstSessionId!)).not.toBeNull();
      expect(pool.getDevice("emulator-5556")!.status).toBe("idle");
      expect(sessionManager.getSession(replacementSessionId!)).toBeNull();

      executionTracker.endExecution(execution.id);
      await monitor.tick();

      expect(pool.getDevice("emulator-5554")!.status).toBe("idle");
      expect(pool.getDevice("emulator-5554")!.autolockSessionId).toBeUndefined();
    });

    it("does not reap an autolock while an implicit call is still resolving", async () => {
      const sessionId = await pool.autolockDevice("emulator-5554", "android", "mcp-session-1");
      const tracker = new ExecutionTracker(timer, new FakeIdGenerator(["implicit"]));
      tracker.setAutolockSessionResolver({
        autolockSessionForMcpSession: (mcpSessionId) =>
          pool.captureAutolockSessionForMcpSession(mcpSessionId),
      });
      const hasActiveExecutions = (sessionUuid: string): boolean =>
        tracker.hasActiveSessionUuidExecutions(sessionUuid) ||
        tracker.hasActiveAutolockSessionExecutions(sessionUuid);
      sessionManager.setActiveSessionExecutionChecker(hasActiveExecutions);
      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        hasActiveExecutions,
        reapVia(sessionManager, pool),
        timer,
      );
      const execution = tracker.startExecution(
        "tapOn",
        "mcp-session-1",
        undefined,
        undefined,
        "mcp-session-1",
      );

      timer.advanceTime(60_001);
      await monitor.tick();
      expect(sessionManager.getSession(sessionId!)).not.toBeNull();
      expect(pool.getDevice("emulator-5554")!.status).toBe("busy");

      tracker.endExecution(execution.id);
      await monitor.tick();
      expect(sessionManager.getSession(sessionId!)).toBeNull();
    });

    it("does not pin the mapped autolock for an explicit call to another session", async () => {
      const mappedSessionId = await pool.autolockDevice(
        "emulator-5554",
        "android",
        "mcp-session-1",
      );
      const explicitSessionId = await pool.autolockDevice(
        "emulator-5556",
        "android",
        "other-mcp-session",
      );
      const executionTracker = new ExecutionTracker(timer);
      const hasActiveExecutions = (sessionUuid: string): boolean =>
        executionTracker.hasActiveSessionUuidExecutions(sessionUuid) ||
        executionTracker.hasActiveAutolockSessionExecutions(sessionUuid);
      sessionManager.setActiveSessionExecutionChecker(hasActiveExecutions);
      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        hasActiveExecutions,
        reapVia(sessionManager, pool),
        timer,
      );
      const execution = executionTracker.startExecution(
        "tapOn",
        "mcp-session-1",
        explicitSessionId,
      );

      timer.advanceTime(60_001);
      await monitor.tick();

      expect(pool.getDevice("emulator-5554")!.status).toBe("idle");
      expect(sessionManager.getSession(mappedSessionId!)).toBeNull();
      expect(pool.getDevice("emulator-5556")!.autolockSessionId).toBe(explicitSessionId);
      expect(sessionManager.getSession(explicitSessionId!)).not.toBeNull();

      executionTracker.endExecution(execution.id);
      await monitor.tick();

      expect(pool.getDevice("emulator-5556")!.status).toBe("idle");
    });
  });
});
