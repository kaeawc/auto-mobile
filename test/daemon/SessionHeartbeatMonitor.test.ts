import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { ExecutionTracker } from "../../src/server/executionTracker";
import { FakeTimer } from "../fakes/FakeTimer";
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

  beforeEach(() => {
    clearAutolockEnv();
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer);
  });

  afterEach(() => {
    sessionManager.stopCleanupTimer();
    clearAutolockEnv();
  });

  describe("scheduling", () => {
    it("start registers an interval and stop clears it", () => {
      const before = timer.getPendingIntervalCount();
      const monitor = new SessionHeartbeatMonitor(sessionManager, () => false, async () => {}, timer);

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
        async sid => { reaped.push(sid); },
        timer,
      );
      monitor.start();

      // Past the pre-first-heartbeat grace on the first scan: reaped.
      timer.advanceTime(10_000);
      await Promise.resolve();
      expect(reaped).toEqual(["s1"]);

      monitor.stop();
    });
  });

  describe("tick reaping decision", () => {
    it("does not reap a default-heartbeat session still within the pre-first-heartbeat grace period", async () => {
      await sessionManager.createSession("s1", "emulator-5554", "android", 60_000);
      const reaped: string[] = [];
      const monitor = new SessionHeartbeatMonitor(sessionManager, () => false, async sid => { reaped.push(sid); }, timer);

      timer.advanceTime(5_000);
      await monitor.tick();

      expect(reaped).toEqual([]);
    });

    it("reaps a default-heartbeat session shortly after it misses the first heartbeat", async () => {
      await sessionManager.createSession("s1", "emulator-5554", "android", 60_000);
      const reaped: string[] = [];
      const monitor = new SessionHeartbeatMonitor(sessionManager, () => false, async sid => { reaped.push(sid); }, timer);

      timer.advanceTime(5_001);
      await monitor.tick();

      expect(reaped).toEqual(["s1"]);
    });

    it("does not reap a default-heartbeat session with recent activity before its first heartbeat", async () => {
      await sessionManager.createSession("s1", "emulator-5554", "android", 60_000);
      const reaped: string[] = [];
      const monitor = new SessionHeartbeatMonitor(sessionManager, () => false, async sid => { reaped.push(sid); }, timer);

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
      const monitor = new SessionHeartbeatMonitor(sessionManager, () => true, async sid => { reaped.push(sid); }, timer);

      timer.advanceTime(5_001);
      await monitor.tick();

      expect(reaped).toEqual([]);
    });

    it("respects the session's heartbeat timeout (aligned to the idle timeout)", async () => {
      // heartbeatTimeoutMs = 60s, so a quiet session is not reaped at 31s...
      await sessionManager.createSession("s1", "emulator-5554", "android", 60_000, 60_000);
      const reaped: string[] = [];
      const monitor = new SessionHeartbeatMonitor(sessionManager, () => false, async sid => { reaped.push(sid); }, timer);

      timer.advanceTime(31_000);
      await monitor.tick();
      expect(reaped).toEqual([]);
    });

    it("treats explicit heartbeat timeout as custom even when it equals the configured default", async () => {
      process.env.AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS = "60000";
      await sessionManager.createSession("default-session", "emulator-5554", "android", 60_000);
      await sessionManager.createSession("custom-session", "emulator-5556", "android", 60_000, 60_000);
      const reaped: string[] = [];
      const monitor = new SessionHeartbeatMonitor(sessionManager, () => false, async sid => { reaped.push(sid); }, timer);

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
        async sid => { reaped.push(sid); },
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
        async sid => { reaped.push(sid); },
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
      const blockedReap = new Promise<void>(resolve => { resolveReap = resolve; });
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
      await new Promise<void>(resolve => setImmediate(resolve));
      timer.advanceTime(1);
      expect(reapCount).toBe(2);

      await monitor.stop();
    });
  });

  describe("integration with DevicePool autolock", () => {
    let pool: DevicePool;

    beforeEach(async () => {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
      process.env.AUTOMOBILE_DEVICE_POOL_TIMEOUT = "60"; // 60s idle timeout
      const fakeDeviceUtils = new FakeDeviceUtils();
      const androidDevice = { name: "Pixel 7", platform: "android" as const, deviceId: "emulator-5554" };
      fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
      pool = new DevicePool(sessionManager, "daemon-test", timer, undefined, fakeDeviceUtils);
      await pool.initializeWithDevices([androidDevice]);
    });

    // Mirrors daemon.ts cancelAndReleaseSession (minus execution cancellation).
    const reapVia = (mgr: SessionManager, devicePool: DevicePool) => async (sid: string): Promise<void> => {
      const deviceId = await mgr.releaseSession(sid);
      if (deviceId) {
        await devicePool.releaseDevice(deviceId, sid);
      }
    };

    it("releases an idle autolocked device promptly after the idle timeout", async () => {
      const sessionId = await pool.autolockDevice("emulator-5554", "android");
      expect(pool.getDevice("emulator-5554")!.status).toBe("busy");

      const monitor = new SessionHeartbeatMonitor(sessionManager, () => false, reapVia(sessionManager, pool), timer);

      // Just past grace but well within the 60s idle window: still locked.
      timer.advanceTime(30_000);
      await monitor.tick();
      expect(pool.getDevice("emulator-5554")!.status).toBe("busy");

      // Past the idle window with no activity: swept and released on the next tick
      // (monitor interval granularity), not the 5-minute cleanup sweep.
      timer.advanceTime(31_000);
      await monitor.tick();

      const device = pool.getDevice("emulator-5554")!;
      expect(device.status).toBe("idle");
      expect(device.autolockSessionId).toBeUndefined();
      expect(sessionManager.getSession(sessionId!)).toBeNull();
    });

    it("keeps the device locked while it is being actively used", async () => {
      const sessionId = await pool.autolockDevice("emulator-5554", "android");
      const monitor = new SessionHeartbeatMonitor(sessionManager, () => false, reapVia(sessionManager, pool), timer);

      // Interact every 40s (exceeds old 10s window, within 60s idle window).
      for (let i = 0; i < 5; i++) {
        timer.advanceTime(40_000);
        await sessionManager.getOrCreateSession(sessionId!); // bumps lastHeartbeat
        await monitor.tick();
        expect(pool.getDevice("emulator-5554")!.status).toBe("busy");
      }
    });

    it("keeps an expired autolocked session assigned until active work completes", async () => {
      const sessionId = await pool.autolockDevice("emulator-5554", "android", "mcp-session-1");
      const executionTracker = new ExecutionTracker(timer);
      const hasActiveExecutions = (sessionUuid: string): boolean =>
        executionTracker.hasActiveSessionUuidExecutions(sessionUuid)
        || pool.hasActiveAutolockMcpSessionExecution(
          sessionUuid,
          mcpSessionId => executionTracker.hasActiveSessionExecutions(mcpSessionId),
        );
      sessionManager.setActiveSessionExecutionChecker(hasActiveExecutions);
      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        hasActiveExecutions,
        reapVia(sessionManager, pool),
        timer,
      );
      const execution = executionTracker.startExecution("tapOn", "mcp-session-1");

      timer.advanceTime(60_001); // Past the autolock idle timeout.
      await monitor.tick();

      const activeDevice = pool.getDevice("emulator-5554")!;
      expect(activeDevice.status).toBe("busy");
      expect(activeDevice.autolockSessionId).toBe(sessionId);
      expect(sessionManager.getActiveSessionCount()).toBe(1);
      expect(sessionManager.getSession(sessionId!)).not.toBeNull();

      executionTracker.endExecution(execution.id);
      await monitor.tick();

      const releasedDevice = pool.getDevice("emulator-5554")!;
      expect(releasedDevice.status).toBe("idle");
      expect(releasedDevice.autolockSessionId).toBeUndefined();
      expect(sessionManager.getActiveSessionCount()).toBe(0);
    });
  });
});
