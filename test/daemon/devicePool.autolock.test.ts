import { describe, it, expect, beforeEach } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";

describe("DevicePool autolock", () => {
  let pool: DevicePool;
  let sessionManager: SessionManager;
  let timer: FakeTimer;
  let fakeDeviceUtils: FakeDeviceUtils;

  beforeEach(() => {
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

  it("autolockDevice returns undefined when autolock is disabled", async () => {
    // DEVICE_POOL_AUTOLOCK_ENABLED defaults to false (no env var set)
    await pool.initializeWithDevices([
      { name: "Pixel 7", platform: "android", deviceId: "emulator-5554" },
    ]);

    const sessionId = await pool.autolockDevice("emulator-5554", "android");
    expect(sessionId).toBeUndefined();
  });

  it("assigns device to session when pool has the device", async () => {
    // We can test the session creation path directly through assignDeviceToSession
    await pool.initializeWithDevices([
      { name: "Pixel 7", platform: "android", deviceId: "emulator-5554" },
    ]);

    const deviceId = await pool.assignDeviceToSession("test-session-uuid", "android");
    expect(deviceId).toBe("emulator-5554");

    const session = sessionManager.getSession("test-session-uuid");
    expect(session).not.toBeNull();
    expect(session!.assignedDevice).toBe("emulator-5554");
  });

  it("session expires and frees device after timeout", async () => {
    await pool.initializeWithDevices([
      { name: "Pixel 7", platform: "android", deviceId: "emulator-5554" },
    ]);

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
});
