import { describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";

const handset: BootedDevice = { name: "SM-S911B", platform: "android", deviceId: "R58M1234ABC" };

// #11413: observers learn of pool status and holder changes after the change committed.
describe("DevicePool state-change listener", () => {
  async function setup(
    onDeviceStateChanged: (deviceId: string, platform: string) => void,
  ): Promise<{ pool: DevicePool; sessions: SessionManager }> {
    const timer = new FakeTimer();
    const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const deviceManager = new FakeDeviceManager();
    deviceManager.bootedDevices = [handset];
    const pool = DevicePool.create({
      sessionManager: sessions,
      daemonSessionId: "state-change",
      timer,
      installedAppsRepository: new FakeInstalledAppsRepository(),
      deviceManager,
      onDeviceStateChanged,
    });
    await pool.initializeWithDevices([handset]);
    return { pool, sessions };
  }

  test("fires after assignment and after release, each with committed state", async () => {
    const seen: Array<[string, string | null, string]> = [];
    const holder: { pool?: DevicePool } = {};
    const { pool, sessions } = await setup((deviceId, platform) => {
      const device = holder.pool?.getDevice(deviceId);
      seen.push([platform, device?.sessionId ?? null, device?.status ?? "missing"]);
    });
    holder.pool = pool;
    try {
      const sessionId = await pool.bindOrReuseDeviceSession("s1", handset.deviceId, "android");
      expect(seen).toEqual([["android", sessionId, "busy"]]);

      await pool.releaseDevice(handset.deviceId, sessionId);
      expect(seen).toHaveLength(2);
      expect(seen[1]).toEqual(["android", null, "idle"]);
    } finally {
      sessions.stopCleanupTimer();
    }
  });

  test("fires when repeated errors mark the device as error", async () => {
    const seen: string[] = [];
    const { pool, sessions } = await setup((deviceId) => seen.push(deviceId));
    try {
      for (let i = 0; i < 10 && seen.length === 0; i++) {
        pool.recordDeviceError(handset.deviceId);
      }
      expect(pool.getDevice(handset.deviceId)?.status).toBe("error");
      expect(seen).toEqual([handset.deviceId]);
    } finally {
      sessions.stopCleanupTimer();
    }
  });

  test("a throwing listener does not fail the pool operation", async () => {
    const { pool, sessions } = await setup(() => {
      throw new Error("observer boom");
    });
    try {
      const sessionId = await pool.bindOrReuseDeviceSession("s1", handset.deviceId, "android");
      expect(pool.getDevice(handset.deviceId)?.sessionId).toBe(sessionId);
    } finally {
      sessions.stopCleanupTimer();
    }
  });
});
