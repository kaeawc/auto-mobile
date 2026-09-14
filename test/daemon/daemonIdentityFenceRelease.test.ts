import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import type {
  DeviceSessionActivityUpdate,
  DeviceSessionRecord,
  DeviceSessionRepository,
} from "../../src/db/deviceSessionRepository";
import type { DeviceSessionStatus } from "../../src/db/types";
import type { DevicePool } from "../../src/daemon/devicePool";
import type { BootedDevice } from "../../src/models";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";

class FakeDeviceSessionRepository {
  readonly released: string[] = [];

  async upsertActiveSession(_record: DeviceSessionRecord): Promise<void> {}

  async recordActivity(_sessionUuid: string, _update: DeviceSessionActivityUpdate): Promise<void> {}

  async markReleased(
    sessionUuid: string,
    _status: DeviceSessionStatus,
    _releasedAtMs: number,
    _reason: string,
  ): Promise<void> {
    this.released.push(sessionUuid);
  }

  async markStaleActiveSessionsExpired(): Promise<void> {}
}

function stubPoolDiscovery(devicePool: DevicePool, devices: BootedDevice[]): FakeDeviceManager {
  const deviceManager = new FakeDeviceManager();
  deviceManager.bootedDevices = [...devices];
  Object.assign(devicePool, { deviceManager });
  return deviceManager;
}

const stamped = (device: BootedDevice, observedAt: number): BootedDevice => ({
  ...device,
  observedAt,
});

describe("Daemon identity fence at the session-release commit (#7031 round 2)", () => {
  beforeEach(() => resetDbWriteBarrier());

  afterEach(() => {
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    resetDbWriteBarrier();
  });

  test("keeps a session whose identity is re-confirmed while release awaits setup work", async () => {
    // The daemon's own releaser passes the pre-release fence, then the session
    // manager awaits tracked setup. The newer confirmation that lands during
    // that await must stop the stale eviction from retiring the live session.
    const timer = new FakeTimer();
    const repository = new FakeDeviceSessionRepository();
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      timer,
      repository as unknown as DeviceSessionRepository,
    );
    const sessionManager = daemon.getSessionManager();
    const devicePool = daemon.getDevicePool();
    const device = stamped(
      { name: "Pixel_8_API_35", deviceId: "emulator-5554", platform: "android" },
      1,
    );
    const replacement = stamped({ ...device, name: "Pixel_7_API_34" }, 2);
    const setupFinished = Promise.withResolvers<void>();

    try {
      const deviceManager = stubPoolDiscovery(devicePool, [device]);
      await devicePool.initializeWithDevices([device]);
      await devicePool.reconcileDiscoveryObservation([device], "test:initial");
      await devicePool.bindOrReuseDeviceSession("owner-session", device.deviceId, "android");
      const pooled = devicePool.getDevice(device.deviceId);
      const session = sessionManager.getSession("owner-session");
      if (!pooled || !session) {
        throw new Error("expected pooled device and session");
      }
      const setup = sessionManager.trackSessionSetup(session, () => setupFinished.promise);

      deviceManager.bootedDevices = [replacement];
      const refresh = devicePool.refreshDevices();
      // Release refuses new setup once it has begun: an unadmitted probe proves
      // the eviction is already inside the release, past the daemon's early
      // fence, so the newer confirmation below hits the commit-point fence.
      // Only microtasks are yielded, so the wait is deterministic and bounded.
      let releaseBegan = false;
      for (let i = 0; i < 1000 && !releaseBegan; i++) {
        await Promise.resolve();
        releaseBegan = true;
        await sessionManager.trackSessionSetup(session, async () => {
          releaseBegan = false;
        });
      }
      expect(releaseBegan).toBe(true);
      expect(sessionManager.getSession("owner-session")).toBe(session);

      await devicePool.reconcileDiscoveryObservation([stamped(device, 3)], "test:newer");
      setupFinished.resolve();
      await setup;
      await refresh;

      expect(sessionManager.getSession("owner-session")).toBe(session);
      expect(sessionManager.getSessionForDevice(device.deviceId)).toBe("owner-session");
      expect(devicePool.getDevice(device.deviceId)).toBe(pooled);
      expect(pooled.sessionId).toBe("owner-session");
      expect(repository.released).toEqual([]);
    } finally {
      setupFinished.resolve();
      sessionManager.stopCleanupTimer();
    }
  });
});
