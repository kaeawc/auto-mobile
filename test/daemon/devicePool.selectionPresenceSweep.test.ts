import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";

// #6546: idle-device selection must take ONE cache-busted Android discovery
// sweep per pass and judge every candidate against it, rather than one sweep
// per rejected candidate while assignmentMutex is held.
describe("DevicePool idle selection Android presence sweep", () => {
  let pool: DevicePool;
  let timer: FakeTimer;
  let fakeDeviceUtils: FakeDeviceUtils;
  const emulators = ["emulator-5554", "emulator-5556", "emulator-5558", "emulator-5560"].map(
    (deviceId, index) => ({ name: `Pixel ${index}`, platform: "android" as const, deviceId }),
  );

  beforeEach(async () => {
    timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    fakeDeviceUtils = new FakeDeviceUtils();
    pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session-1", {
        timer: timer,
        deviceManager: fakeDeviceUtils,
      }),
    );
    fakeDeviceUtils.setBootedDevices("android", emulators);
    await pool.initializeWithDevices(emulators);
  });

  afterEach(() => {
    timer.clearAllTimers?.();
  });

  async function assignWithLiveDevices(liveCount: number): Promise<string> {
    // Keep only the last `liveCount` emulators booted; the rest are stale.
    fakeDeviceUtils.setBootedDevices("android", emulators.slice(emulators.length - liveCount));
    fakeDeviceUtils.clearHistory();
    return await pool.assignDeviceToSession("session-1", "android");
  }

  it("takes one sweep when the first candidate is live", async () => {
    await assignWithLiveDevices(4);
    expect(fakeDeviceUtils.getCallCount("getBootedDevices")).toBe(1);
  });

  it("takes one sweep regardless of how many stale candidates it rejects", async () => {
    const deviceId = await assignWithLiveDevices(1);

    expect(deviceId).toBe("emulator-5560");
    expect(fakeDeviceUtils.getCallCount("getBootedDevices")).toBe(1);
  });

  it("skips absent candidates until fenced refresh misses confirm eviction", async () => {
    await assignWithLiveDevices(1);

    const pooledIds = pool.getAllDevices().map((device) => device.id);
    expect(pooledIds).toContain("emulator-5560");
    for (const staleId of ["emulator-5554", "emulator-5556", "emulator-5558"]) {
      expect(pool.getDevice(staleId)?.sessionId).toBeNull();
      expect(pool.getDevice(staleId)?.status).toBe("idle");
    }
    for (let miss = 0; miss < 3; miss++) {
      await pool.refreshDevices();
    }
    for (const staleId of ["emulator-5554", "emulator-5556", "emulator-5558"]) {
      const entry = pool.getAllDevices().find((device) => device.id === staleId);
      expect(entry === undefined || entry.status === "error").toBe(true);
    }
  });
});
