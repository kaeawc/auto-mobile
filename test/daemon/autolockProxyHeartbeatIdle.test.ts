import { drainUntil } from "../helpers/fakeTimerStepping";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { describe, it, expect, afterEach } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";

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

const HEARTBEAT_INTERVAL_MS = 5_000;

describe("autolock idle release with a heartbeating stdio proxy (#10658)", () => {
  let pool: DevicePool;
  let sessionManager: SessionManager;
  let timer: FakeTimer;
  const androidDevice = {
    name: "Pixel 7",
    platform: "android" as const,
    deviceId: "emulator-5554",
  };

  const heartbeatFor = (sessionId: string, ms: number): void => {
    for (let elapsed = 0; elapsed < ms; elapsed += HEARTBEAT_INTERVAL_MS) {
      timer.advanceTime(HEARTBEAT_INTERVAL_MS);
      sessionManager.recordHeartbeat(sessionId);
    }
  };

  const setup = async (autolock: boolean): Promise<string | undefined> => {
    clearAutolockEnv();
    if (autolock) {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
      process.env.AUTOMOBILE_DEVICE_POOL_TIMEOUT = "60";
    }
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const fakeDeviceUtils = new FakeDeviceUtils();
    pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session-1", {
        timer,
        deviceManager: fakeDeviceUtils,
      }),
    );
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    await pool.initializeWithDevices([androidDevice]);
    return autolock ? pool.autolockDevice("emulator-5554", "android") : undefined;
  };

  afterEach(() => {
    clearAutolockEnv();
  });

  it("releases the device after the idle timeout although the proxy keeps heartbeating", async () => {
    const sessionId = (await setup(true))!;
    heartbeatFor(sessionId, 90_000);

    expect(sessionManager.getSession(sessionId)).toBeNull();
    await drainUntil(() => pool.getDevice("emulator-5554")!.status === "idle", {
      description: "idle autolocked device released",
    });
    expect(pool.getDevice("emulator-5554")!.autolockSessionId).toBeUndefined();
  });

  it("a tool call resets the idle window while heartbeats continue", async () => {
    const sessionId = (await setup(true))!;
    heartbeatFor(sessionId, 50_000);
    await sessionManager.getOrCreateSession(sessionId);
    heartbeatFor(sessionId, 50_000);

    // 100 s since acquisition but only 50 s since the last tool call.
    expect(sessionManager.getSession(sessionId)).not.toBeNull();
    expect(pool.getDevice("emulator-5554")!.status).toBe("busy");

    heartbeatFor(sessionId, 40_000);
    expect(sessionManager.getSession(sessionId)).toBeNull();
  });

  it("leaves the pool unlocked when autolock is off", async () => {
    await setup(false);
    expect(pool.getDevice("emulator-5554")!.status).toBe("idle");
    expect(pool.getDevice("emulator-5554")!.autolockSessionId).toBeUndefined();
  });
});
