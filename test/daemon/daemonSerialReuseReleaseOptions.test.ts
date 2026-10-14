import { expect, spyOn } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import { DeviceLockRepository } from "../../src/db/deviceLockRepository";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import type { BootedDevice } from "../../src/models";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionRepository } from "../fakes/FakeDeviceSessionRepository";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { warmedTests } from "../helpers/warmedTests";

// Use the real constructor/pool wiring seam from daemonIdentityFenceRelease.test.ts.
const test = warmedTests(() => {
  DaemonState.getInstance().reset();
  NavigationGraphManager.resetInstance();
  resetDbWriteBarrier();
});
const original: BootedDevice = {
  deviceId: "emulator-5554",
  name: "AVD-A",
  platform: "android",
  observedAt: 1,
};

async function fixture() {
  const timer = new FakeTimer();
  const daemon = new Daemon(
    {},
    new FakeInstalledAppsRepository(),
    timer,
    new FakeDeviceSessionRepository(),
  );
  const sessions = daemon.getSessionManager();
  sessions.stopCleanupTimer();
  const pool = daemon.getDevicePool();
  const manager = new FakeDeviceManager([], [original]);
  Object.assign(pool, { deviceManager: manager });
  const restores: string[] = [];
  Object.assign(sessions, {
    getBarrier: () => new FakeDbWriteBarrier(),
    keepScreenAwakeRestorerFactory: (device: BootedDevice) => ({
      restore: async () => {
        restores.push(device.deviceId);
        return { status: "restored" as const };
      },
    }),
  });
  const release = spyOn(sessions, "releaseSession");
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const forget = spyOn(DeviceLockRepository.prototype, "forget").mockResolvedValue(undefined);
  const cleanup = () => {
    pool.releaseDeviceClaimsForShutdown();
    sessions.stopCleanupTimer();
    timer.reset();
    release.mockRestore();
    warn.mockRestore();
    forget.mockRestore();
  };
  await pool.initializeWithDevices([original]);
  await pool.bindOrReuseDeviceSession("holder", original.deviceId, "android");
  sessions.setKeepScreenAwake("holder", { applied: true, method: "settings" });
  return { pool, sessions, manager, restores, release, cleanup };
}

test("daemon serial-reuse wiring forwards identity replacement and sends no restore", async () => {
  const h = await fixture();
  try {
    h.manager.bootedDevices = [{ ...original, name: "AVD-B", observedAt: 10 }];
    expect(await h.pool.settlePooledRuntimeIdentity(original.deviceId)).toBe("replaced");
    expect(h.release.mock.calls[0]?.[4]).toEqual({ deviceIdentityReplaced: true });
    expect(h.restores).toEqual([]);
    expect(h.sessions.getSession("holder")).toBeNull();
    expect(h.pool.getDevice(original.deviceId)).toMatchObject({ name: "AVD-B", sessionId: null });
  } finally {
    h.cleanup();
  }
});

for (const fenced of [true, false]) {
  test(`daemon ordinary device-loss wiring retains restores with fence=${fenced}`, async () => {
    const h = await fixture();
    try {
      await h.pool["releaseSessionForDisconnectedDevice"](
        "holder",
        original.deviceId,
        "device-disconnected:emulator-5554",
        fenced ? () => true : undefined,
      );
      expect(h.release.mock.calls[0]?.[4]?.deviceIdentityReplaced).toBeUndefined();
      expect(h.restores).toEqual([original.deviceId]);
    } finally {
      h.cleanup();
    }
  });
}
