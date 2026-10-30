import { deliverDaemonHeartbeat } from "../helpers/daemonHeartbeatHandler";
import { makePool } from "../helpers/makePool";
import { expect, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { SessionReleaseBroadcaster } from "../../src/daemon/sessionReleaseBroadcast";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";

async function setup() {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const manager = new SessionManager(timer, persistence, {
    barrier: () => new FakeDbWriteBarrier(),
  });
  const device = { deviceId: "emulator-5554", name: "Pixel", platform: "android" as const };
  const utils = new FakeDeviceUtils();
  utils.setBootedDevices("android", [device]);
  const pool = makePool(manager, "test-daemon", { timer, deviceManager: utils });
  await pool.initializeWithDevices([device]);
  await manager.createSession("owner", device.deviceId, "android", {
    timeoutMs: 1_000,
    heartbeatTimeoutMs: 1_000,
  });
  await pool.bindOrReuseDeviceSession({
    sessionId: "owner",
    deviceId: device.deviceId,
    platform: "android",
  });
  await deliverDaemonHeartbeat(manager, "owner");
  manager.stopCleanupTimer();
  return { timer, persistence, manager, pool, device };
}

test.each(["cleanup", "lookup"] as const)(
  "equal idle/heartbeat deadlines free the pooled device through %s and keep the heartbeat diagnostic",
  async (path) => {
    const { timer, persistence, manager, pool, device } = await setup();
    const reasons: Array<string | undefined> = [];
    const unsubscribe = SessionReleaseBroadcaster.subscribe((_id, reason) => reasons.push(reason));
    manager.onSessionRelease((id, _device, reason, { snapshot }) => {
      SessionReleaseBroadcaster.emit(id, reason, snapshot);
    });
    try {
      expect(pool.getDevice(device.deviceId)).toMatchObject({ status: "busy", sessionId: "owner" });
      timer.setCurrentTime(11_001);
      if (path === "cleanup") {
        manager.cleanupExpiredSessions();
      } else {
        expect(manager.getSession("owner")).toBeNull();
      }
      await manager.waitForSessionRelease("owner");
      await drainUntilQuiescent(timer);
      expect(await persistence.getSession("owner")).toMatchObject({
        status: "expired",
        release_reason: "heartbeat-timeout",
      });
      expect(reasons).toEqual(["heartbeat-timeout"]);
      expect(pool.getDevice(device.deviceId)).toMatchObject({ status: "idle", sessionId: null });
      expect(pool.getStats().idle).toBe(1);
      await expect(pool.assignDeviceToSession("replacement", "android")).resolves.toBe(
        device.deviceId,
      );
    } finally {
      unsubscribe();
      manager.stopCleanupTimer();
    }
  },
);

test("caller-driven release captures the device until the caller returns it to the pool", async () => {
  const { timer, persistence, manager, pool, device } = await setup();
  try {
    await expect(manager.releaseSession("owner", "explicit-release")).resolves.toBe(
      device.deviceId,
    );
    await drainUntilQuiescent(timer);
    expect(await persistence.getSession("owner")).toMatchObject({
      release_reason: "explicit-release",
    });
    expect(pool.getDevice(device.deviceId)).toMatchObject({ status: "busy", sessionId: "owner" });
    await pool.releaseDevice(device.deviceId, "owner");
    expect(pool.getDevice(device.deviceId)).toMatchObject({ status: "idle", sessionId: null });
  } finally {
    manager.stopCleanupTimer();
  }
});
