import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { ActionableError } from "../../src/models";

const AUTOLOCK_ENV_KEYS = [
  "AUTOMOBILE_DEVICE_POOL_AUTOLOCK",
  "AUTO_MOBILE_DEVICE_POOL_AUTOLOCK",
] as const;
const TIMEOUT_ENV_KEYS = [
  "AUTOMOBILE_DEVICE_POOL_TIMEOUT",
  "AUTO_MOBILE_DEVICE_POOL_TIMEOUT",
] as const;

function clearAutolockEnv(): void {
  for (const key of [...AUTOLOCK_ENV_KEYS, ...TIMEOUT_ENV_KEYS]) {
    delete process.env[key];
  }
}

describe("DevicePool autolock", () => {
  let pool: DevicePool;
  let sessionManager: SessionManager;
  let timer: FakeTimer;
  let fakeDeviceUtils: FakeDeviceUtils;
  const androidDevice = { name: "Pixel 7", platform: "android" as const, deviceId: "emulator-5554" };

  const initializeLiveAndroidDevice = async (): Promise<void> => {
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    await pool.initializeWithDevices([androidDevice]);
  };

  beforeEach(() => {
    clearAutolockEnv();
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer);
    fakeDeviceUtils = new FakeDeviceUtils();

    pool = new DevicePool(
      sessionManager,
      "daemon-session-1",
      timer,
      undefined,
      fakeDeviceUtils,
    );
  });

  afterEach(() => {
    clearAutolockEnv();
  });

  it("autolockDevice returns undefined when autolock is disabled", async () => {
    // Autolock env not set -> disabled
    await pool.initializeWithDevices([
      { name: "Pixel 7", platform: "android", deviceId: "emulator-5554" },
    ]);

    const sessionId = await pool.autolockDevice("emulator-5554", "android");
    expect(sessionId).toBeUndefined();
  });

  it("assigns device to session when pool has the device", async () => {
    // We can test the session creation path directly through assignDeviceToSession
    await initializeLiveAndroidDevice();

    const deviceId = await pool.assignDeviceToSession("test-session-uuid", "android");
    expect(deviceId).toBe("emulator-5554");

    const session = sessionManager.getSession("test-session-uuid");
    expect(session).not.toBeNull();
    expect(session!.assignedDevice).toBe("emulator-5554");
  });

  it("session expires and frees device after timeout", async () => {
    await initializeLiveAndroidDevice();

    // Create session with short timeout
    await pool.assignDeviceToSession("test-session", "android");

    // Session exists
    expect(sessionManager.getSession("test-session")).not.toBeNull();

    // Advance past the session timeout (30 min default)
    timer.advanceTime(31 * 60 * 1000);

    // Session should now be expired
    const session = sessionManager.getSession("test-session");
    expect(session).toBeNull();
  });

  it("does not auto-start a device image after that pool device disconnects", async () => {
    const androidImage = {
      name: "Medium_Phone_API_35",
      platform: "android" as const,
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local" as const,
    };

    fakeDeviceUtils.setDeviceImages("android", [androidImage]);
    fakeDeviceUtils.setBootedDevices("android", []);
    await pool.initializeWithDevices([
      { name: "Medium_Phone_API_35", platform: "android", deviceId: "emulator-5554" },
    ]);

    await pool.removeDisconnectedDevice("emulator-5554");

    await expect(pool.assignMultipleDevices(["next-session"], 1000, "android")).rejects.toThrow(ActionableError);
    expect(fakeDeviceUtils.getCallCount("startDevice")).toBe(0);
  });

  it("does not suppress auto-start when disconnected removal is blocked by assignment", async () => {
    const androidImage = {
      name: "Medium_Phone_API_35",
      platform: "android" as const,
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local" as const,
    };

    const bootedDevice = { name: "Medium_Phone_API_35", platform: "android" as const, deviceId: "emulator-5554" };
    fakeDeviceUtils.setDeviceImages("android", [androidImage]);
    fakeDeviceUtils.setBootedDevices("android", [bootedDevice]);
    await pool.initializeWithDevices([bootedDevice]);

    await pool.assignDeviceToSession("active-session", "android");
    fakeDeviceUtils.setBootedDevices("android", []);
    fakeDeviceUtils.markDeviceAsStopped("Medium_Phone_API_35");
    fakeDeviceUtils.markDeviceAsStopped("emulator-5554");
    await pool.removeDisconnectedDevice("emulator-5554");
    await pool.releaseDevice("emulator-5554", "active-session");
    await pool.removeDevice("emulator-5554");

    const assignments = await pool.assignMultipleDevices(["next-session"], 1000, "android");

    expect(assignments.get("next-session")).toBe("emulator-5554");
    expect(fakeDeviceUtils.getCallCount("startDevice")).toBe(1);
  });

  it("createSession accepts custom timeout", async () => {
    const session = await sessionManager.createSession(
      "autolock-session",
      "emulator-5554",
      "android",
      5000, // 5 second timeout
    );

    expect(session.expiresAt).toBe(timer.now() + 5000);
  });

  it("session with custom timeout expires at correct time", async () => {
    await sessionManager.createSession(
      "autolock-session",
      "emulator-5554",
      "android",
      5000,
    );

    // Not expired yet
    timer.advanceTime(4000);
    expect(sessionManager.getSession("autolock-session")).not.toBeNull();

    // Now expired
    timer.advanceTime(2000);
    expect(sessionManager.getSession("autolock-session")).toBeNull();
  });

  it("heartbeat extends session expiry", async () => {
    await sessionManager.createSession(
      "autolock-session",
      "emulator-5554",
      "android",
      5000,
    );

    // Advance to just before expiry
    timer.advanceTime(4000);
    sessionManager.recordHeartbeat("autolock-session");

    // Would have expired without heartbeat
    timer.advanceTime(2000);
    expect(sessionManager.getSession("autolock-session")).not.toBeNull();
  });

  describe("when autolock is enabled", () => {
    beforeEach(() => {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
      // 60 second idle timeout
      process.env.AUTOMOBILE_DEVICE_POOL_TIMEOUT = "60";
    });

    it("locks the device to a generated session UUID", async () => {
      await initializeLiveAndroidDevice();

      const sessionId = await pool.autolockDevice("emulator-5554", "android");

      expect(sessionId).toBeDefined();
      const device = pool.getDevice("emulator-5554")!;
      expect(device.status).toBe("busy");
      expect(device.sessionId).toBe(sessionId!);
      expect(device.autolockSessionId).toBe(sessionId!);

      // Session created with the configured idle timeout
      const session = sessionManager.getSession(sessionId!);
      expect(session).not.toBeNull();
      expect(session!.assignedDevice).toBe("emulator-5554");
      expect(session!.expiresAt).toBe(timer.now() + 60_000);
    });

    it("rejects autolock for a stale idle iOS simulator", async () => {
      await pool.initializeWithDevices([
        { name: "iPhone 15", platform: "ios", deviceId: "sim-stale" },
      ]);
      fakeDeviceUtils.setBootedDevices("ios", []);

      await expect(pool.autolockDevice("sim-stale", "ios"))
        .rejects.toThrow(/not available for autolock/);
      expect(pool.getDevice("sim-stale")).toBeNull();
    });

    it("maps an MCP session to its generated autolock session", async () => {
      await initializeLiveAndroidDevice();

      const sessionId = await pool.autolockDevice("emulator-5554", "android", "mcp-session-1");

      expect(pool.resolveAutolockSessionForMcpSession("mcp-session-1", "android")).toBe(sessionId);
      expect(pool.resolveAutolockSessionForMcpSession("mcp-session-1", "ios")).toBeUndefined();
      expect(pool.resolveAutolockSessionForMcpSession("other-mcp-session", "android")).toBeUndefined();
    });

    it("clears MCP session mapping when the autolock session expires", async () => {
      await initializeLiveAndroidDevice();

      const sessionId = await pool.autolockDevice("emulator-5554", "android", "mcp-session-1");
      expect(pool.resolveAutolockSessionForMcpSession("mcp-session-1", "android")).toBe(sessionId);

      timer.advanceTime(61 * 1000);
      expect(sessionManager.getSession(sessionId!)).toBeNull();

      expect(pool.resolveAutolockSessionForMcpSession("mcp-session-1", "android")).toBeUndefined();
    });

    it("does not route a new MCP request through an expired autolock held by older work", async () => {
      await initializeLiveAndroidDevice();
      sessionManager.setActiveSessionExecutionChecker((_sessionId, startedAtOrBefore) => startedAtOrBefore === undefined);

      await pool.autolockDevice("emulator-5554", "android", "mcp-session-1");
      timer.advanceTime(61 * 1000);

      expect(pool.resolveAutolockSessionForMcpSession("mcp-session-1", "android")).toBeUndefined();
      expect(pool.getDevice("emulator-5554")!.status).toBe("idle");
    });

    it("rejects a late MCP request while earlier work still owns the expired autolock", async () => {
      await initializeLiveAndroidDevice();
      sessionManager.setActiveSessionExecutionChecker((_sessionId, query) => query?.excludeExecutionId === "late");

      await pool.autolockDevice("emulator-5554", "android", "mcp-session-1");
      timer.advanceTime(61 * 1000);

      expect(() => pool.resolveAutolockSessionForMcpSession(
        "mcp-session-1",
        "android",
        { executionId: "late", startTime: timer.now() },
      )).toThrow("earlier work is still active");
      expect(pool.getDevice("emulator-5554")!.status).toBe("busy");
    });

    it("aligns the session heartbeat timeout with the idle timeout", async () => {
      // The daemon heartbeat watchdog reaps sessions whose heartbeat is stale.
      // Autolock clients do not send heartbeats, so the heartbeat timeout must
      // match the idle timeout or the device would be released far too early.
      await initializeLiveAndroidDevice();

      const sessionId = await pool.autolockDevice("emulator-5554", "android");
      const session = sessionManager.getSession(sessionId!);

      expect(session!.heartbeatTimeoutMs).toBe(60_000);
      // Not the default 10s heartbeat window that would reap a non-heartbeating client.
      expect(session!.heartbeatTimeoutMs).not.toBe(SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS);
    });

    it("survives the daemon heartbeat watchdog until the idle timeout", async () => {
      // Mirrors SessionHeartbeatMonitor: default-heartbeat sessions that never
      // heartbeat are reaped quickly, while custom-heartbeat sessions use the
      // normal heartbeat timeout after the initial grace.
      const PRE_FIRST_HEARTBEAT_GRACE_MS = 5_000;
      const CUSTOM_HEARTBEAT_INITIAL_GRACE_MS = 20_000;
      const wouldReap = (
        createdAt: number,
        lastHeartbeat: number,
        heartbeatTimeoutMs: number,
        heartbeatTimeoutSource: "default" | "custom",
        now: number,
        hasReceivedHeartbeat: boolean
      ): boolean => {
        if (!hasReceivedHeartbeat) {
          if (heartbeatTimeoutSource === "default") {
            return now - createdAt > PRE_FIRST_HEARTBEAT_GRACE_MS;
          }
          if (now - createdAt < CUSTOM_HEARTBEAT_INITIAL_GRACE_MS) {
            return false;
          }
        }
        return now - lastHeartbeat > heartbeatTimeoutMs;
      };

      await initializeLiveAndroidDevice();

      const sessionId = await pool.autolockDevice("emulator-5554", "android");
      const session = sessionManager.getSession(sessionId!)!;

      // With the OLD 10s heartbeat timeout the watchdog would have reaped this at ~20s.
      expect(
        wouldReap(session.createdAt, session.lastHeartbeat, SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS, "default", 20_000, false)
      ).toBe(true);

      // With the aligned timeout it survives the grace + well past the old window...
      expect(
        wouldReap(session.createdAt, session.lastHeartbeat, session.heartbeatTimeoutMs, session.heartbeatTimeoutSource, 30_000, false)
      ).toBe(false);

      // ...and is only reaped once the idle timeout elapses with no activity.
      expect(
        wouldReap(session.createdAt, session.lastHeartbeat, session.heartbeatTimeoutMs, session.heartbeatTimeoutSource, 60_001, false)
      ).toBe(true);
    });

    it("ongoing interaction keeps an autolocked device alive past the heartbeat window", async () => {
      // Integration: a locked device driven through repeated session resolutions
      // (createToolExecutionContext -> getOrCreateSession on every tool call)
      // must not be reaped by the heartbeat watchdog, because each interaction
      // bumps lastHeartbeat. Mirrors SessionHeartbeatMonitor for a custom
      // heartbeat timeout.
      const CUSTOM_HEARTBEAT_INITIAL_GRACE_MS = 20_000;
      const reapableAt = (session: { createdAt: number; lastHeartbeat: number; heartbeatTimeoutMs: number; hasReceivedHeartbeat: boolean }, now: number): boolean => {
        if (!session.hasReceivedHeartbeat && now - session.createdAt < CUSTOM_HEARTBEAT_INITIAL_GRACE_MS) {
          return false;
        }
        return now - session.lastHeartbeat > session.heartbeatTimeoutMs;
      };

      await initializeLiveAndroidDevice();

      const sessionId = await pool.autolockDevice("emulator-5554", "android");

      // Simulate a client interacting every 40s for 200s — each call exceeds the
      // old 10s heartbeat window but is well within the 60s idle window.
      for (let elapsed = 40_000; elapsed <= 200_000; elapsed += 40_000) {
        timer.advanceTime(40_000);
        await sessionManager.getOrCreateSession(sessionId!);
        const live = sessionManager.getSession(sessionId!)!;
        expect(reapableAt(live, timer.now())).toBe(false);
      }

      // Device is still locked after 200s of active use.
      expect(pool.getDevice("emulator-5554")!.status).toBe("busy");

      // Snapshot the live session, then stop interacting: once the heartbeat window
      // elapses with no further activity, the watchdog predicate would reap it.
      const snapshot = { ...sessionManager.getSession(sessionId!)! };
      expect(reapableAt(snapshot, timer.now() + 61_000)).toBe(true);
    });

    it("auto-releases the device after the idle timeout (periodic cleanup)", async () => {
      await initializeLiveAndroidDevice();

      const sessionId = await pool.autolockDevice("emulator-5554", "android");
      expect(pool.getDevice("emulator-5554")!.status).toBe("busy");

      // Advance past both the idle timeout (60s) and the cleanup interval (5 min),
      // so the periodic cleanup fires and releases the expired session's device.
      timer.advanceTime(6 * 60 * 1000);

      const device = pool.getDevice("emulator-5554")!;
      expect(device.status).toBe("idle");
      expect(device.sessionId).toBeNull();
      expect(device.autolockSessionId).toBeUndefined();
      expect(sessionManager.getSession(sessionId!)).toBeNull();
    });

    it("auto-releases the device on lazy session expiry", async () => {
      await initializeLiveAndroidDevice();

      const sessionId = await pool.autolockDevice("emulator-5554", "android");

      // Past the 60s timeout but before the 5-min cleanup interval.
      timer.advanceTime(61 * 1000);

      // Touching the expired session lazily expires it and fires the release callback.
      expect(sessionManager.getSession(sessionId!)).toBeNull();

      const device = pool.getDevice("emulator-5554")!;
      expect(device.status).toBe("idle");
      expect(device.autolockSessionId).toBeUndefined();
    });

    it("a stale lock released by the idle timeout lets a new session acquire the device", async () => {
      // Symmetric to the auto-release cases above: an expired session's lock must
      // not permanently strand the device. Prove a real before/after transition on
      // the acquire itself — the new session is refused while the stale lock holds
      // the device, then succeeds once the idle timeout frees it.
      await initializeLiveAndroidDevice();

      await pool.autolockDevice("emulator-5554", "android");
      expect(pool.getDevice("emulator-5554")!.status).toBe("busy");

      // BEFORE advancing time: the stale lock still holds the only device busy, so
      // a new session cannot acquire it. timeoutMs === the 1s wait interval yields
      // maxAttempts 1, so allocation fails fast (no retry sleep, no hang).
      await expect(
        pool.assignMultipleDevices(["new-session"], 1000, "android"),
      ).rejects.toThrow(ActionableError);
      expect(pool.getDevice("emulator-5554")!.sessionId).not.toBe("new-session");

      // Advance past the idle timeout (60s) and the cleanup interval (5 min) so the
      // periodic sweep releases the expired autolock session's device.
      timer.advanceTime(6 * 60 * 1000);

      // AFTER advancing time: the freed device is acquirable by the new session.
      const assignments = await pool.assignMultipleDevices(["new-session"], 1000, "android");
      expect(assignments.get("new-session")).toBe("emulator-5554");
      expect(pool.getDevice("emulator-5554")!.sessionId).toBe("new-session");
    });

    it("heartbeat before the idle timeout keeps the device locked", async () => {
      await initializeLiveAndroidDevice();

      const sessionId = await pool.autolockDevice("emulator-5554", "android");

      // Just before timeout, record activity.
      timer.advanceTime(59 * 1000);
      sessionManager.recordHeartbeat(sessionId!);

      // Another window passes; without the heartbeat this would have expired.
      timer.advanceTime(30 * 1000);

      expect(sessionManager.getSession(sessionId!)).not.toBeNull();
      expect(pool.getDevice("emulator-5554")!.status).toBe("busy");
    });

    it("does not release a device re-locked by a different session", async () => {
      await initializeLiveAndroidDevice();

      const firstSession = await pool.autolockDevice("emulator-5554", "android");
      // Simulate the device being re-locked under a new session before the old
      // session's release callback fires.
      const device = pool.getDevice("emulator-5554")!;
      device.autolockSessionId = "new-session";
      device.sessionId = "new-session";
      device.status = "busy";

      // Expire the original session.
      timer.advanceTime(61 * 1000);
      expect(sessionManager.getSession(firstSession!)).toBeNull();

      // The stale release for the first session must not free the re-locked device.
      const after = pool.getDevice("emulator-5554")!;
      expect(after.status).toBe("busy");
      expect(after.autolockSessionId).toBe("new-session");
    });

    describe("assertAutolockAccess", () => {
      beforeEach(async () => {
        await initializeLiveAndroidDevice();
      });

      it("allows the owning session", async () => {
        const sessionId = await pool.autolockDevice("emulator-5554", "android");
        expect(() => pool.assertAutolockAccess("emulator-5554", sessionId)).not.toThrow();
      });

      it("rejects a different session", async () => {
        await pool.autolockDevice("emulator-5554", "android");
        expect(() => pool.assertAutolockAccess("emulator-5554", "other-session")).toThrow(
          ActionableError,
        );
      });

      it("rejects an absent session", async () => {
        await pool.autolockDevice("emulator-5554", "android");
        expect(() => pool.assertAutolockAccess("emulator-5554", undefined)).toThrow(
          ActionableError,
        );
      });

      it("no-ops when the device is not locked", () => {
        expect(() => pool.assertAutolockAccess("emulator-5554", "any-session")).not.toThrow();
      });

      it("no-ops for an unknown device", () => {
        expect(() => pool.assertAutolockAccess("does-not-exist", undefined)).not.toThrow();
      });
    });
  });

  it("assertAutolockAccess no-ops when autolock is disabled even if a device is locked", async () => {
    // Lock a device while enabled...
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    await initializeLiveAndroidDevice();
    await pool.autolockDevice("emulator-5554", "android");

    // ...then disable autolock: enforcement is bypassed.
    clearAutolockEnv();
    expect(() => pool.assertAutolockAccess("emulator-5554", "mismatched")).not.toThrow();
  });
});
