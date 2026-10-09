import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { forceStuckSessionRelease } from "../../src/daemon/releaseSessionAndDevice";
import {
  SESSION_RELEASE_TEARDOWN_CAP_MS,
  SESSION_SETUP_DRAIN_TIMEOUT_MS,
  SessionManager,
  type KeepScreenAwakeRestorer,
} from "../../src/daemon/sessionManager";
import type { DeviceSessionRecord } from "../../src/db/deviceSessionRepository";
import type { DeviceSessionStatus } from "../../src/db/types";
import type { RotationRestoreState } from "../../src/features/action/Rotate";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { getAbortSignal } from "../../src/utils/AbortContext";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceHealthMarkers } from "../fakes/FakeDeviceHealthMarkers";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

// #11058: follow-ups to the forced stuck release (#10963, #11044).

const first = { deviceId: "emulator-5554", name: "Pixel A", platform: "android" as const };
const second = { deviceId: "emulator-5556", name: "Pixel B", platform: "android" as const };
const flush = async () => {
  for (let index = 0; index < 200; index++) {
    await Promise.resolve();
  }
};

/** Release writes can be parked, like a wedged SQLite write. */
class ParkablePersistence extends FakeDeviceSessionPersistence {
  parkRelease: Promise<void> | undefined;
  readonly releaseWrites: string[] = [];

  override async upsertActiveSession(record: DeviceSessionRecord): Promise<void> {
    await super.upsertActiveSession(record);
  }

  override async markReleased(
    sessionUuid: string,
    status: DeviceSessionStatus,
    releasedAtMs: number,
    reason: string,
  ): Promise<void> {
    this.releaseWrites.push(`${sessionUuid}:${status}:${reason}`);
    await this.parkRelease;
    await super.markReleased(sessionUuid, status, releasedAtMs, reason);
  }
}

/** A keep-awake restore that stays parked until the test lets it go. */
class ParkedKeepAwake implements KeepScreenAwakeRestorer {
  readonly gate = Promise.withResolvers<void>();
  signal: AbortSignal | undefined;
  calls = 0;
  async restore(): Promise<void> {
    this.calls++;
    this.signal = getAbortSignal();
    await this.gate.promise;
  }
}

const managers: SessionManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager.stopCleanupTimer();
  }
  DaemonState.getInstance().reset();
  ToolRegistry.clearTools();
  PlatformDeviceManagerFactory.reset();
});

async function harness() {
  const timer = new FakeTimer();
  timer.setCurrentTime(1000);
  const persistence = new ParkablePersistence();
  const keepAwake = new ParkedKeepAwake();
  const rotations: string[] = [];
  const manager = new SessionManager(
    timer,
    persistence,
    () => new FakeDbWriteBarrier(),
    () => keepAwake,
    undefined,
    {
      networkCondition: () => ({ restore: async () => {} }),
      clock: () => ({ restore: async () => {} }),
      rotation: (device) => ({
        restore: async () => {
          rotations.push(device.deviceId);
        },
      }),
    },
  );
  managers.push(manager);
  const utils = new FakeDeviceUtils();
  utils.setBootedDevices("android", [first, second]);
  PlatformDeviceManagerFactory.setInstance(utils);
  const pool = new DevicePool(
    createDevicePoolDependencies(manager, "forced-release-followups", {
      timer,
      deviceManager: utils,
      deviceHealthMarkers: new FakeDeviceHealthMarkers(timer),
    }),
  );
  await pool.initializeWithDevices([first, second]);
  return { timer, persistence, manager, pool, keepAwake, rotations };
}

const rotation: RotationRestoreState = { accelerometerRotation: 1, userRotation: 0 };

async function bindShapedSession(h: Awaited<ReturnType<typeof harness>>, sessionId: string) {
  await h.pool.bindOrReuseDeviceSession(sessionId, first.deviceId, "android");
  h.manager.setKeepScreenAwake(sessionId, { applied: true, method: "settings" });
  h.manager.setRotation(h.manager.getSession(sessionId)!, rotation);
}

describe("a forced stuck release stops touching the device (#11058 item 1)", () => {
  test("forcing during a parked restore aborts it and starts no later restore", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const h = await harness();
      await bindShapedSession(h, "a");
      void h.manager.releaseSession("a", "heartbeat-timeout");
      await flush();
      expect(h.keepAwake.calls).toBe(1);
      expect(h.keepAwake.signal?.aborted).toBe(false);

      const forced = h.manager.forceStuckRelease("a");
      expect(forced?.stage).toBe("teardown");
      // The parked restore's signal is aborted, so its device commands fail before dispatch.
      expect(h.keepAwake.signal?.aborted).toBe(true);

      const freeing = forceStuckSessionRelease({ forceStuckRelease: () => forced }, h.pool, "a");
      await h.timer.advanceTimeAsync(SESSION_RELEASE_TEARDOWN_CAP_MS);
      await freeing;
      await flush();
      await h.pool.bindOrReuseDeviceSession("b", first.deviceId, "android");
      expect(h.pool.getDevice(first.deviceId)?.sessionId).toBe("b");

      h.keepAwake.gate.resolve();
      await flush();
      await h.timer.advanceTimeAsync(SESSION_RELEASE_TEARDOWN_CAP_MS);
      await flush();
      // A's rotation restore never ran against the device B now owns.
      expect(h.rotations).toEqual([]);
      expect(h.manager.hasDeviceCleanupInProgress(first.deviceId)).toBe(false);
      expect(h.manager.getSessionForDevice(first.deviceId)).toBe("b");
    } finally {
      warn.mockRestore();
    }
  });

  test("a release forced in terminal-persist never quarantines the next owner's device", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const h = await harness();
      await h.pool.bindOrReuseDeviceSession("a", first.deviceId, "android");
      // Setup work that outlives the release's setup drain is handed back as pending cleanup.
      const setupGate = Promise.withResolvers<void>();
      void h.manager.trackSessionSetup(h.manager.getSession("a")!, () => setupGate.promise);
      const persistGate = Promise.withResolvers<void>();
      h.persistence.parkRelease = persistGate.promise;
      void h.manager.releaseSession("a", "heartbeat-timeout");
      await flush();
      await h.timer.advanceTimeAsync(SESSION_SETUP_DRAIN_TIMEOUT_MS);
      await flush();

      const forced = h.manager.forceStuckRelease("a");
      expect(forced?.stage).toBe("terminal-persist");
      const freeing = forceStuckSessionRelease({ forceStuckRelease: () => forced }, h.pool, "a");
      await h.timer.advanceTimeAsync(SESSION_RELEASE_TEARDOWN_CAP_MS);
      await freeing;
      await flush();
      h.persistence.parkRelease = undefined;
      await h.pool.bindOrReuseDeviceSession("b", first.deviceId, "android");
      expect(h.manager.hasDeviceCleanupInProgress(first.deviceId)).toBe(false);

      // The stuck write lands after B owns the device: A's still-pending setup must not mark
      // B's device as cleaning.
      persistGate.resolve();
      await flush();
      expect(h.manager.hasDeviceCleanupInProgress(first.deviceId)).toBe(false);
      expect(h.manager.getSessionForDevice(first.deviceId)).toBe("b");
      setupGate.resolve();
    } finally {
      warn.mockRestore();
    }
  });
});
