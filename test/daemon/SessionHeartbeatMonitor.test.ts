import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";

const AUTOLOCK_ENV_KEYS = [
  "AUTOMOBILE_DEVICE_POOL_AUTOLOCK",
  "AUTO_MOBILE_DEVICE_POOL_AUTOLOCK",
  "AUTOMOBILE_DEVICE_POOL_TIMEOUT",
  "AUTO_MOBILE_DEVICE_POOL_TIMEOUT",
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
      await sessionManager.createSession("s1", "emulator-5554", "android", 60_000, 10_000);
      const reaped: string[] = [];
      const monitor = new SessionHeartbeatMonitor(
        sessionManager,
        () => false,
        async sid => { reaped.push(sid); },
        timer,
      );
      monitor.start();

      // Within grace: interval fires but nothing is reaped.
      timer.advanceTime(10_000);
      expect(reaped).toEqual([]);

      // Past grace (20s) and past the 10s heartbeat window with no activity: reaped.
      timer.advanceTime(20_000);
      await Promise.resolve();
      expect(reaped).toEqual(["s1"]);

      monitor.stop();
    });
  });

  describe("tick reaping decision", () => {
    it("does not reap a session still within the initial grace period", async () => {
      await sessionManager.createSession("s1", "emulator-5554", "android", 60_000, 10_000);
      const reaped: string[] = [];
      const monitor = new SessionHeartbeatMonitor(sessionManager, () => false, async sid => { reaped.push(sid); }, timer);

      timer.advanceTime(15_000); // < 20s grace, no heartbeat yet
      await monitor.tick();

      expect(reaped).toEqual([]);
    });

    it("reaps a stale session after the grace period", async () => {
      await sessionManager.createSession("s1", "emulator-5554", "android", 60_000, 10_000);
      const reaped: string[] = [];
      const monitor = new SessionHeartbeatMonitor(sessionManager, () => false, async sid => { reaped.push(sid); }, timer);

      timer.advanceTime(31_000); // past grace and past the 10s heartbeat window
      await monitor.tick();

      expect(reaped).toEqual(["s1"]);
    });

    it("skips a session with active executions", async () => {
      await sessionManager.createSession("s1", "emulator-5554", "android", 60_000, 10_000);
      const reaped: string[] = [];
      const monitor = new SessionHeartbeatMonitor(sessionManager, () => true, async sid => { reaped.push(sid); }, timer);

      timer.advanceTime(31_000);
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
  });

  describe("integration with DevicePool autolock", () => {
    let pool: DevicePool;

    beforeEach(async () => {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
      process.env.AUTOMOBILE_DEVICE_POOL_TIMEOUT = "60"; // 60s idle timeout
      pool = new DevicePool(sessionManager, "daemon-test", timer, undefined, new FakeDeviceUtils());
      await pool.initializeWithDevices([
        { name: "Pixel 7", platform: "android", deviceId: "emulator-5554" },
      ]);
    });

    // Mirrors daemon.ts cancelAndReleaseSession (minus execution cancellation).
    const reapVia = (mgr: SessionManager, devicePool: DevicePool) => async (sid: string): Promise<void> => {
      const deviceId = await mgr.releaseSession(sid);
      if (deviceId) {
        await devicePool.releaseDevice(deviceId);
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
  });
});
